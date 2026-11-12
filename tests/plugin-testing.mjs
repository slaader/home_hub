// home-hub/testing: what a plugin's tests import from core, by name (package.json → exports):
//   import {hub, createHandler, hashPassword} from 'home-hub/testing';
// Together with server/plugin-api.mjs this is the plugin contract and falls under semver (AGENTS.md → Versioning).
// Re-exports only. docs/plugins.md → Tests.
import {fileURLToPath} from 'node:url';

// A hub for a test: createHandler with fakes in its options (they arrive as hub.options), and the ready helper that
// starts one on a temp directory with a signed-in administrator (tests/hub-helper.mjs).
export {createHandler,buildRegistry,STARTUP_PLUGINS} from '../server/index.mjs';
export {hub,credentials,knowledge,SITE} from './hub-helper.mjs';
// Sign-in and accounts.
export {hashPassword,createAuth} from '../server/auth.mjs';
export {createAccessStore} from '../server/access-store.mjs';
export {SCOPES,scopeFor,legacyScopes} from '../server/scopes.mjs';
// The site configuration.
export {site,loadSite,validateSite,machineKind,sshHosts} from '../server/site-config.mjs';
// What a household's tests check its data and plugins against: the edition, the overview's machine definitions and
// stacks, the systems collector's parser, the LLM page's model graph and the runtime adapters' read paths, the
// inventory file's rules and the software watch list's place. These follow core: a MINOR release may add to them,
// and a change of meaning is a MAJOR one like any other name here.
export {readEdition} from '../server/edition.mjs';
export {homeDefinitions,stackLayouts} from '../server/home-data.mjs';
export {systemMachines,buildSystems,parseSystemsProbe} from '../server/systems-data.mjs';
export {liveState,placements,buildGraph,cleanRequest} from '../server/models-data.mjs';
export {READ_PATHS,EVENT_PATH} from '../server/runtime-adapters.mjs';
export {walk as walkKnowledge,find as findKnowledge,load as loadKnowledge,validStore,storeNames} from '../scripts/check-knowledge.mjs';
export {softwareWatchPath} from '../server/site-config.mjs';
// The front-end test hook: lets Node import a page module the way the browser does ('/views.js',
// '/plugins/<id>/x.js'). scripts/run-tests.mjs loads it with --import; another runner can do the same.
export const BROWSER_PATHS_HOOK=fileURLToPath(new URL('./support/browser-paths.mjs',import.meta.url));
// Core's own test fixtures (tests/fixtures/): a generic site, runtime answers, …
export const CORE_FIXTURES=fileURLToPath(new URL('./fixtures/',import.meta.url));
