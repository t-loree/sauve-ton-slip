// Service worker Sauve ton slip : tout le site fonctionne hors ligne (sauf les tuiles OSM).
// Stratégie « stale-while-revalidate » : réponse immédiate depuis le cache (aucune attente
// réseau, économe en batterie), mise à jour du cache en arrière-plan pour la fois suivante.
// Changer CACHE force le re-téléchargement complet.
const CACHE = 'cyclo-v47';
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

const ASSETS = [
	'page/',
	'page/trone-finder/',
	'page/water/',
	'page/repair/',
	'page/parking/',
	'page/route/',
	'manifest.json',
	'css/cyclo.css',
	'css/nav.css',
	'css/ol.css',
	'js/lib/ol.js',
	'js/script/layout.js',
	'js/script/meteo.js',
	'js/script/pluie.js',
	'js/script/poi.js',
	'js/script/services.js',
	'js/script/router.js',
	'js/script/nav.js',
	'js/script/routePage.js',
	'img/icons.svg',
	'img/logo.svg',
	'img/velo-anime.svg',
	'img/glyph/water.svg',
	'img/glyph/toilet.svg',
	'img/glyph/repair.svg',
	'img/glyph/parking.svg',
	'img/apple-touch-icon.png',
	'img/icon-192.png',
	'img/icon-512.png',
	'favicon.ico',
	// points de service par région (pipeline/04_poi.py) et index des graphes ; les tuiles t/*.bin.gz sont mises en cache à l'usage
	...['bretagne', 'reunion'].flatMap(r => [
		...['toilet', 'water', 'repair', 'parking'].map(s => `data/poi/${r}/${s}.geojson`),
		`data/graph/${r}/meta.json`,
	]),
];

// Installation : mise en cache fichier par fichier (un fichier manquant ne bloque pas le reste)
self.addEventListener('install', event => {
	event.waitUntil(
		caches.open(CACHE).then(cache => Promise.all(ASSETS.map(url =>
			cache.add(url).catch(err => console.warn('SW : non mis en cache', url, err))
		)))
	);
	self.skipWaiting();
});

// Activation : suppression des anciens caches
self.addEventListener('activate', event => {
	event.waitUntil(
		caches.keys().then(keys =>
			// seulement nos anciennes versions : « sts-radar » (pluie.js) se gère lui-même
			Promise.all(keys.filter(k => k.startsWith('cyclo-') && k !== CACHE).map(k => caches.delete(k)))
		)
	);
	self.clients.claim();
});

// Les requêtes externes (tuiles OSM, météo Open-Meteo, radar RainViewer) passent directement au réseau
self.addEventListener('fetch', event => {
	const req = event.request;
	// seulement nos fichiers : le domaine (t-loree.github.io) est partagé avec d'autres projets
	if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
	// En développement (localhost) : réseau d'abord, pour voir les modifications tout de suite
	// Clé de cache sans « ?… » : /page/route/?a=…&b=… (lien « Guider » des pages de services, différent à
	// chaque fois) partage la copie de /page/route/ au lieu d'en ajouter une par lien.
	const url = new URL(req.url);
	url.search = '';
	const key = url.href;
	if (DEV) {
		event.respondWith(fetch(req).then(resp => {
			if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
			return resp;
		}).catch(() => caches.match(key)));
		return;
	}
	event.respondWith(caches.open(CACHE).then(async cache => {
		const cached = await cache.match(key);
		const network = fetch(req).then(resp => {
			if (resp.ok) cache.put(key, resp.clone());
			return resp;
		}).catch(() => cached);
		if (cached) { event.waitUntil(network); return cached; }
		return network;
	}));
});
