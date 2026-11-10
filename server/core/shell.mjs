// Core module "shell": what the browser shell is made of besides app.js: the theme (and the script
// that applies a stored choice before the first paint), icons, the command palette, the watcher that notices
// when the hub stops answering, and the getting-started checklist (#welcome, public/welcome-view.js).
// The checklist reads the APIs that already exist (public/onboarding.js); this module adds no routes and
// keeps no state.
export default {
 id:'shell',title:'Shell',
 assets:['theme-boot.js','theme.js','icons.js','palette.js','net.js','onboarding.js','welcome-view.js'],
 nav:[{hash:'welcome',labelKey:'První kroky',view:'welcome-view.js#welcomePage',hidden:true}],
};
