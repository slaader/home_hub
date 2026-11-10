import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { scopeIds } from './scopes.mjs';
const derive = promisify(scrypt);
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
// Sessions in memory: the fallback for tests and previews. The server passes db.sessions (state/hub.db), so a
// restart or deploy keeps everyone signed in. Either way only the SHA-256 of a token is stored, never the token.
export function memorySessions() {
  const map = new Map();
  return { get: h => map.get(h), set: (h, s) => map.set(h, s), delete: h => map.delete(h),
    prune: t => { for (const [h, s] of map) if (s.until < t) map.delete(h); }, get size() { return map.size; } };
}
const hashOf = token => createHash('sha256').update(token).digest('hex');
const tokenOf = raw => /(?:^|;\s*)homehub=([a-f0-9]{64})(?:;|$)/.exec(raw)?.[1];
export function createAuth(credentials, { secure = true, now = Date.now, accounts, sessions = memorySessions() } = {}) {
  const attempts = new Map();
  const lookup = raw => { const token = tokenOf(raw); return token ? sessions.get(hashOf(token)) : undefined; };
  const cookie = (token, age) => `homehub=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function prune() {
    sessions.prune(now());
    for (const [key, value] of attempts) if (value.until < now()) attempts.delete(key);
  }
  // A session only lives while its user is active and still has the password it signed in with
  // (passwordAt changes on every reset, so an exact match avoids clock and same-millisecond races).
  // Without an access store there is one account: the owner of the credentials, who may do everything.
  const soleOwner=()=>({id:'owner',username:credentials.username,role:'admin',roleId:'owner',admin:true,permission:'write',scopes:scopeIds()});
  function current(session){const user=accounts.user(session.userId);return user&&(user.passwordAt??null)===session.passwordAt?user:null;}
  return {
    async login(username, password, ip) {
      prune();
      if (attempts.size > 1000 || sessions.size > 1000) return { status: 429 };
      const entry = attempts.get(ip) || { count: 0, until: now() + 900000 };
      if (entry.count >= 8) return { status: 429 };
      entry.count++; attempts.set(ip, entry);
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) return { status: 400 };
      let user;
      if(accounts)user=await accounts.authenticate(username,password);
      else{const candidate=await derive(password,credentials.salt,64);if(username===credentials.username&&timingSafeEqual(candidate,Buffer.from(credentials.hash,'hex')))user=soleOwner();}
      if(!user)return {status:401};
      attempts.delete(ip);
      const token = randomBytes(32).toString('hex'); sessions.set(hashOf(token), {until:now()+43200000,userId:user.id,passwordAt:user.passwordAt??null});
      return { status: 200, cookie: cookie(token, 43200) };
    },
    valid(raw = '') {
      prune(); const session=lookup(raw);return Boolean(session&&session.until>now()&&(!accounts||current(session)));
    },
    principal(raw=''){
      prune();const session=lookup(raw);
      if(!session||session.until<=now())return null;const user=accounts?current(session):soleOwner();
      // The access store says what the person's role allows (scopes, permission, admin); a store that
      // does not is read the old way: an admin writes, anyone else reads.
      return user?{...user,authKind:'session',permission:user.permission??(user.role==='admin'?'write':'read'),scopes:user.scopes??(user.role==='admin'?scopeIds():['read'])}:null;
    },
    logout(raw = '') {
      const token = tokenOf(raw); if (token) sessions.delete(hashOf(token)); return cookie('', 0);
    }
  };
}
