// Where things are: the one place that decides where Home Hub's configuration, data, state and secrets live
// (docs/storage.md → Where everything is). Code asks this module; it never joins the checkout with "private"
// or "data" itself.
//
//   HOME_HUB_HOME          an instance directory that holds config/, data/ and private/ apart from the code
//   HOME_HUB_CONFIG_DIR    the household configuration: site.json, software-watch.json, images/
//   HOME_HUB_SITE_CONFIG   the site file itself ("none" = no file)
//   DATA_DIR, STATE_DIR    collector output and inventory; what the hub writes (hub.db, access.json, …)
//   HOME_HUB_PRIVATE_DIR   secrets: auth.json, secret.key, tokens, keys (0700/0600)
//   AUTH_FILE              the owner's sign-in file
//
// | Variable             | With HOME_HUB_HOME   | Without (the checkout's own, as before) |
// | HOME_HUB_CONFIG_DIR  | <home>/config        | <root>/local                            |
// | HOME_HUB_SITE_CONFIG | <config>/site.json   | <root>/local/site.json                  |
// | DATA_DIR             | <home>/data          | <root>/data                             |
// | STATE_DIR            | <data>/state         | <data>/state                            |
// | HOME_HUB_PRIVATE_DIR | <home>/private       | <root>/private                          |
// | AUTH_FILE            | <private>/auth.json  | <root>/private/auth.json                |
//
// The two <root>/local defaults are the in-tree overlay: deprecated, removed in 2.0 (CHANGELOG.md → Deprecated).
// A variable that is set always wins over the default derived from another one. With none of them set every
// path is exactly what it was before this module existed. DATA_DIR, STATE_DIR and AUTH_FILE are returned as
// given (relative values stay relative to the working directory, as they always were); every other value is absolute.
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {repoRoot} from './edition.mjs';

const PLUGIN_ID=/^[a-z][a-z0-9-]{1,31}$/;
const abs=value=>path.resolve(value);

/** → frozen {root, home, config, siteConfig, softwareWatch, data, state, private, authFile}. home is null without HOME_HUB_HOME. */
export function resolvePaths(env=process.env,root=repoRoot){
 const home=env.HOME_HUB_HOME?abs(env.HOME_HUB_HOME):null;
 const config=env.HOME_HUB_CONFIG_DIR?abs(env.HOME_HUB_CONFIG_DIR):home?path.join(home,'config'):path.join(root,'local');
 const siteConfig=env.HOME_HUB_SITE_CONFIG==='none'?null:env.HOME_HUB_SITE_CONFIG?abs(env.HOME_HUB_SITE_CONFIG):path.join(config,'site.json');
 // The software watch list lives beside the site file, so a hub started with another site file, or with none,
 // never reads this one's. SOFTWARE_WATCH_FILE selects another file.
 const softwareWatch=env.SOFTWARE_WATCH_FILE?abs(env.SOFTWARE_WATCH_FILE):siteConfig?path.join(path.dirname(siteConfig),'software-watch.json'):null;
 const data=env.DATA_DIR||(home?path.join(home,'data'):path.join(root,'data'));
 const state=env.STATE_DIR||path.join(data,'state');
 const privateDirectory=env.HOME_HUB_PRIVATE_DIR?abs(env.HOME_HUB_PRIVATE_DIR):home?path.join(home,'private'):path.join(root,'private');
 const authFile=env.AUTH_FILE||path.join(privateDirectory,'auth.json');
 return Object.freeze({root,home,config,siteConfig,softwareWatch,data,state,private:privateDirectory,authFile});
}

// A file in the private directory (private/integrations.json, private/runtime-tokens.json, …): the default of every
// secret file that has its own override variable.
export const privateFile=(name,env=process.env,root=repoRoot)=>path.join(resolvePaths(env,root).private,name);

// A plugin's own data directory: <data>/plugins/<id>/, made 0700 on first use. hub.pluginData(id) is this with the
// hub's data directory, so a plugin never writes inside its code directory.
export function pluginDataDirectory(dataDirectory,id){
 if(typeof id!=='string'||!PLUGIN_ID.test(id))throw new Error(`pluginData: "${id}" is not a plugin id`);
 const directory=path.resolve(dataDirectory,'plugins',id);
 mkdirSync(directory,{recursive:true,mode:0o700});
 return directory;
}
