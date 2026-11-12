// English for the update check: the card and its release block (public/updates-view.js), the footer, and the
// sentences server/update-check.mjs and server/core/updates.mjs build.
export default {
 // the card
 'Kontrola aktualizací Home Hubu':'Home Hub update check',
 'Zhruba dvakrát denně se zeptá GitHubu, jestli vyšlo novější vydání Home Hubu: dva dotazy GET na api.github.com, nic se neposílá. Jen oznamuje; aktualizaci nikdy neinstaluje sám. Vypnutá: Home Hub kvůli aktualizacím nekontaktuje nikoho.':
  'About twice a day it asks GitHub whether a newer release of Home Hub is out: two GET requests to api.github.com, and nothing is sent. It only tells; it never installs an update itself. Off: Home Hub contacts nobody about updates.',
 'Vypnuto proměnnou prostředí HOME_HUB_UPDATE_CHECK=off. Zapnout jde jen tam.':'Turned off by the environment variable HOME_HUB_UPDATE_CHECK=off. It can only be turned on there.',
 'Limit GitHubu':'GitHub rate limit',
 'Vrácená aktualizace':'Rolled-back update',
 // what the check says
 '{version} je nejnovější vydání.':'{version} is the newest release.',
 'Je dostupné vydání {latest} z {date}. Běží {installed}.':'{latest} is available (released {date}). You run {installed}.',
 'Je dostupné vydání {latest}. Běží {installed}.':'{latest} is available. You run {installed}.',
 'Vývojové sestavení {installed}; nejnovější vydání je {latest}.':'Development build {installed}; the newest release is {latest}.',
 'Vývojové sestavení {installed}; je dostupné vydání {latest}.':'Development build {installed}; release {latest} is available.',
 'Repozitář {repo} zatím žádné vydání nezveřejnil. Běží {installed}.':'The repository {repo} has not published a release yet. You run {installed}.',
 'Od {since} se nepodařilo zkontrolovat ({error}). Poslední známé vydání bylo {latest}; jestli je to pořád nejnovější, není známo.':
  'Could not check since {since} ({error}). The last known release was {latest}; whether it is still the newest is not known.',
 'Od {since} se nepodařilo zkontrolovat ({error}). Tehdy repozitář žádné vydání neměl.':'Could not check since {since} ({error}). The repository had no release then.',
 'Poslední úspěšná kontrola byla {since}. Tehdy bylo nejnovější vydání {latest}; jestli to pořád platí, není známo.':
  'The last successful check was {since}. The newest release then was {latest}; whether that still holds is not known.',
 'Poslední úspěšná kontrola byla {since}. Tehdy repozitář žádné vydání neměl.':'The last successful check was {since}. The repository had no release then.',
 'Žádná kontrola se zatím nepovedla ({error}).':'No successful check yet ({error}).',
 'Zatím se nekontrolovalo. První kontrola proběhne během několika minut.':'Not checked yet. The first check runs within a few minutes.',
 'Kontrola aktualizací je vypnutá proměnnou HOME_HUB_UPDATE_CHECK=off. Home Hub nekontaktuje nikoho.':'The update check is turned off by HOME_HUB_UPDATE_CHECK=off. Home Hub contacts nobody.',
 'Není nastavené, odkud vydání číst: package.json → homeHub.updates.repo, nebo updates.repo v site.json.':'Where to read releases from is not set: package.json → homeHub.updates.repo, or updates.repo in site.json.',
 'Kontrola aktualizací je vypnutá. Home Hub nekontaktuje nikoho.':'The update check is off. Home Hub contacts nobody.',
 'GitHub odmítá další dotazy do {until}; do té doby se Home Hub neptá.':'GitHub refuses more requests until {until}; Home Hub does not ask before then.',
 'Vydání {version} se tu {date} zkoušelo a vrátilo zpět ({reason}).':'Release {version} was tried here on {date} and rolled back ({reason}).',
 'Vydání {version} se tu {date} zkoušelo a vrátilo zpět.':'Release {version} was tried here on {date} and rolled back.',
 'Tohle není nejnovější známé vydání.':'This is not the newest known release.',
 // the release block
 'Vydání {version}':'Release {version}',
 'Otevřít na GitHubu':'Open on GitHub',
 'Poznámky k vydání':'Release notes',
 'Home Hub se neaktualizuje sám. Na serveru přepni checkout na {tag} a restartuj ho; postup je v README (Updating).':
  'Home Hub does not update itself. On the server, switch the checkout to {tag} and restart it; the README (Updating) has the steps.',
 'Home Hub se neaktualizuje sám. Aktualizaci provede správce na serveru; postup je v README (Updating).':
  'Home Hub does not update itself. An administrator updates it on the server; the README (Updating) has the steps.',
 'V patičce nepřipomínat':'Do not show in the footer',
 'V patičce se tohle vydání nepřipomíná.':'The footer does not point at this release.',
 'Vydání {version} se už v patičce nepřipomíná.':'The footer no longer points at release {version}.',
 // the footer
 'Je dostupné vydání {latest}. Otevřít Integrace.':'Release {latest} is available. Open Integrations.',
 // the API reference
 'Aktualizace':'Updates',
 'Která verze Home Hubu běží, nejnovější známé vydání a stav kontroly. MCP hub_version (jen čtení).':'Which Home Hub version is running, the newest known release and the state of the check. MCP hub_version (read-only).',
 'Zkontrolovat teď (nejvýš jednou za minutu).':'Check now (at most once a minute).',
 '{version}: na tohle vydání už v patičce neupozorňovat.':'{version}: stop pointing at this release in the footer.',
};
