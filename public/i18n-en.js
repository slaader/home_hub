// English dictionary: Czech source text → English. One file per area so they can be edited apart;
// a key defined twice must have the same translation (tests/i18n.test.mjs checks it).
import shell from './i18n-en-shell.js';
import home from './i18n-en-home.js';
import security from './i18n-en-security.js';
import systems from './i18n-en-systems.js';
import access from './i18n-en-access.js';
import inventory from './i18n-en-inventory.js';
import server from './i18n-en-server.js';
import tracker from './i18n-en-tracker.js';
import review from './i18n-en-review.js';
import integrations from './i18n-en-integrations.js';
import models from './i18n-en-models.js';
import backups from './i18n-en-backups.js';
import gitLfs from './i18n-en-git-lfs.js';
import machines from './i18n-en-machines.js';
export const PARTS=Object.freeze({shell,home,security,systems,access,inventory,server,tracker,review,integrations,models,backups,gitLfs,machines});
export default Object.freeze(Object.assign({},...Object.values(PARTS)));
