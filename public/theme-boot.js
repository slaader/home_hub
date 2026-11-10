// The stored theme choice, applied before the first paint. A classic script on purpose (index.html loads it
// in <head>, before the stylesheets): a module would run after the page has already been drawn in the
// system's colours. "system" stores nothing, and then tokens.css follows prefers-color-scheme.
// theme.js is the module the rest of the UI uses to read and change the choice.
(function(){
 try{var v=localStorage.getItem('hh-theme');if(v==='light'||v==='dark')document.documentElement.setAttribute('data-theme',v);}catch(e){}
})();
