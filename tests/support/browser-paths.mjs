// Lets Node import front-end modules the way the browser does. A plugin's view imports core helpers by
// URL ('/views.js', '/plugins/<id>/x.js'); under `node --test` those are mapped back to the files:
//   /plugins/<id>/<file>  →  <plugins dir>/<id>/public/<file>
//   /<file>               →  public/<file>
// Loaded by scripts/run-tests.mjs with --import. Not used by the server.
import {register} from 'node:module';
register('./browser-paths-hooks.mjs',import.meta.url);
