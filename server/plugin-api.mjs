// The server-side plugin API: what a plugin, its scripts and its host agents import from core, by name:
//   import {tx, provenance} from 'home-hub/plugin-api';
// package.json → exports maps the name here. Inside the core tree (local/plugins/…) Node resolves it through the
// package's self-reference; anywhere else through one link, node_modules/home-hub → the core checkout
// (node scripts/plugins.mjs link). docs/plugins.md → Importing core.
//
// This file and tests/plugin-testing.mjs ARE the plugin contract and fall under semver (AGENTS.md → Versioning):
// a name here is removed or changes meaning only in a MAJOR release. Anything not exported here is internal to
// core and may change in any release. Re-exports only, no logic of its own; every module named here is small and
// imports little, because a host agent (scripts/install-host-agent.mjs) copies this file's whole import closure.
import {readPackage} from './version.mjs';

// Text a module says to people, as a key and its parameters, so the browser can translate it (server/text.mjs).
export {tx,sentences} from './text.mjs';
// The worst of a few integration states, for a status made of parts (docs/plugins.md → Integrations).
export {worstState} from './integration-states.mjs';
// Where the data of an answer comes from (docs/plugins.md → Provenance).
export {provenance,authoredProvenance,collectorSource} from './provenance.mjs';
// A refusal from an MCP tool's run(), sent back to the agent as the tool result.
export {toolError} from './tool-error.mjs';
// A Range header against a file size, for routes that stream media.
export {byteRange} from './http-range.mjs';
// The router census (docs/plugins.md → The router adapter).
export {readRouter,mergeRouter} from './router-data.mjs';
// The inventory file (data/knowledge.json): an editor with the hub's own validation and optimistic hashes.
export {createKnowledgeEditor,entryHash} from '../scripts/knowledge-edit.mjs';
export {validate as validateKnowledge} from '../scripts/check-knowledge.mjs';
// Versions and ranges (plugin.json → core, requires).
export {satisfies,validRange,compare as compareVersions,parse as parseVersion} from './semver.mjs';
// The site configuration (site.json): the process-wide one, or one read from a file (a plugin's script, a collector).
export {site,loadSite} from './site-config.mjs';
// Where configuration, data, state and secrets are (docs/storage.md → Where everything is).
export {resolvePaths} from './paths.mjs';
// What an installed host agent is (its .agent-install.json, written by scripts/install-host-agent.mjs).
export {installedAgent} from './host-agent.mjs';
// The version of the core this plugin runs on: package.json → version ("1.2.0").
export const CORE_VERSION=readPackage().version;
