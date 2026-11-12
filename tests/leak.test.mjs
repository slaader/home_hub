// No household details in the public core. The same scan scripts/export-public.mjs runs before it writes
// an export, over the same files, so `npm test` fails on a leak long before anyone exports.
// In the public edition the scan covers the whole tree and the overlay must be absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {exportFiles,scanLeaks,scanText,scanBinary,formatFindings,isScanned,repoRoot,EXCLUDED_DIRS} from '../scripts/leak-scan.mjs';
import {isPublicRelease} from '../server/edition.mjs';
import {EMPTY_SITE,loadSite,siteConfigPath} from '../server/site-config.mjs';

// Built from pieces so this file does not contain what it looks for.
const owner=['sg','dovin'].join(''),subnet=['192','168','50'].join('.'),siteName=['Sla','ader'].join('');

test('the scanner finds each kind of household detail and lets placeholders through',()=>{
 const hits=text=>scanText('x.md',text).map(f=>f.rule);
 assert.deepEqual(hits(`ssh ${owner}@host`),['owner-name']);
 assert.deepEqual(hits(`at ${subnet}.25`),['home-subnet']);
 assert.deepEqual(hits(`open /Users/${'someone'}/git/x`),['home-path']);
 assert.deepEqual(hits(`Home Hub · ${siteName.toUpperCase()}`),['site-name']);
 assert.deepEqual(hits(`https://nas.home.${owner}.xyz`).sort(),['home-domain','owner-name']);
 assert.deepEqual(hits(`mail me: ${['first.last','mail.somewhere.org'].join('@')}`),['email']);
 for(const fine of ['10.0.0.25 and 192.168.1.1','/Users/alice/.ssh/id_ed25519','dscl . -read "/Users/$u" UserShell','ops@example.com, bot@hub.example.lan, x@test.invalid',
  'sk-ssh-ed25519@openssh.com','git@github.com:owner/repo.git','/api/admin/users/action','https://hub.example.lan'])assert.deepEqual(hits(fine),[],fine);
 assert.deepEqual(scanBinary('x.png',Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0,255]),Buffer.from(`tEXt model_path /Users/${owner}/models`),Buffer.from([0,1,2])])).map(f=>f.rule).sort(),['home-path','owner-name'],'metadata inside a picture is searched too');
 assert.deepEqual(scanBinary('x.png',Buffer.from(`tEXt {"model_path": null, "seed": 11} ${['a','b.cd'].join('@')}`)),[]);
 assert.equal(isScanned('public/app.js'),true);assert.equal(isScanned('public/images/nas.png'),false);assert.equal(isScanned('public/vendor/echarts.esm.min.mjs'),false);
});

// The update check names the public repository, whose owner is the site word. Only that slug passes.
test('the site word passes only as the public repository slug',()=>{
 const word=siteName.toLowerCase(),slug=`${word}/home_hub`;
 const hits=text=>scanText('x.md',text).map(f=>f.rule);
 for(const fine of [`{"homeHub":{"updates":{"repo":"${slug}"}}}`,`releases of \`${slug}\`.`,`see ${slug} for it`,`https://github.com/${slug}`,`https://github.com/${slug}/releases/tag/v1.1.0`,
  `git clone https://github.com/${slug}.git`,`(github.com/${slug})`])assert.deepEqual(hits(fine),[],fine);
 for(const caught of [word,`Home Hub · ${siteName}`,`the ${word} household`,`"siteName":"${siteName}"`,`${word}.json`,`local/${word}/notes.md`,
  `https://github.com/${word}`,`https://github.com/${word}/other-repo`,`https://github.com/${word}/home_hub2`,`https://github.com/${word}/home_hub-private`,`${word}/home_hubs`,
  `https://example.com/${slug}`,`https://gitlab.com/${slug}`,`https://notgithub.com/${slug}`,`https://github.com/x/${slug}`,`/srv/${slug}`,`~/${slug}`,`${siteName}/home_hub`,`${word.toUpperCase()}/home_hub`,
  `user@${slug}`,`x.${slug}`,`${slug} and ${word}`])assert.ok(hits(caught).includes('site-name'),caught);
 assert.deepEqual(hits(`${slug} and ${word}`),['site-name'],'the slug passes, the bare word next to it does not');
 assert.deepEqual(scanBinary('x.png',Buffer.from(`tEXt ${word} studio`)).map(f=>f.rule),['site-name'],'and never in a picture');
 // The slug is written once in core, in package.json; everything else reads it from there.
 const withSlug=exportFiles().filter(f=>isScanned(f)&&readFileSync(path.join(repoRoot,f),'utf8').includes(slug));
 assert.deepEqual(withSlug,['package.json']);
});

test('the export leaves out the overlay, state and deployment files',()=>{
 const files=exportFiles();
 assert.ok(files.length>100);
 for(const f of files)assert.ok(!EXCLUDED_DIRS.some(d=>f===d||f.startsWith(d+'/')),f);
 assert.ok(!files.includes('README.md')&&!files.includes('edition.json'),'the export writes its own README and edition marker');
 for(const must of ['server/index.mjs','server/plugins.mjs','public/app.js','config/site.example.json','docs/plugins.md','AGENTS.md','package.json','tests/leak.test.mjs'])assert.ok(files.includes(must),must);
});

test('no household details in the files a public export includes',()=>{
 const findings=scanLeaks();
 assert.equal(findings.length,0,`\n${formatFindings(findings.slice(0,40))}\n`);
});

test('public edition: no overlay in the tree, nothing seeded, English by default',{skip:!isPublicRelease()&&'private edition: local/ holds the household overlay'},()=>{
 assert.equal(existsSync(path.join(repoRoot,'local','site.json')),false,'a public tree ships no site configuration');
 assert.equal(existsSync(path.join(repoRoot,'local','plugins')),false,'and no plugins');
 assert.equal(loadSite({file:siteConfigPath({})}),EMPTY_SITE);
 const findings=scanLeaks(repoRoot,exportFiles(repoRoot,{generated:true}));
 assert.equal(findings.length,0,`\n${formatFindings(findings.slice(0,40))}\n`);
 assert.equal(EMPTY_SITE.defaultLanguage,'en');assert.deepEqual(EMPTY_SITE.tracker.projects,[]);assert.deepEqual(EMPTY_SITE.machines,[]);
});
