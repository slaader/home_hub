// Front-end tests that draw the inventory map: give public/site.js the fixture site's inventory vocabulary
// (places with their columns), the way app.js does from the UI manifest.
import {readFileSync} from 'node:fs';
import {setSite} from '../../public/site.js';
setSite({inventory:JSON.parse(readFileSync(new URL('../fixtures/site.json',import.meta.url),'utf8')).inventory});
