// Pages de services (eau potable, toilettes, réparation, parking vélo).
// L'identifiant du service est celui de la page : <body data-page="<id>"> (pas de script dans le HTML, cf. CSP). Dépend de ol.js, poi.js (SERVICES, POI) et router.js.
//
// Panneau : « autour de moi », filtres par type, liste des points les plus proches, fiche du point.
// Itinéraire vers un point calculé localement (graphe ROUTER_GRAPH_URL, chargé à la demande).

const SERVICE = document.body.dataset.page;
const S = SERVICES[SERVICE];
const $ = id => document.getElementById(id);
const cssVar = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
const COLOR = POI.color(SERVICE);
const BRAND = cssVar('--brand', '#0E6E6B');
const ICON = name => `<svg class="icon" aria-hidden="true"><use href="${site('img/icons.svg')}#i-${name}"/></svg>`;
const DOT = `<span class="poi-dot" style="background:${COLOR}">${ICON(S.icon)}</span>`;
const LIST_SIZE = 20;

const KX = 111319.5 * Math.cos(48 * Math.PI / 180), KY = 111132.9;
const distM = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
const fmtDist = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const typeKeys = Object.keys(S.types);
const titleOf = f => f.get('name') || S.types[f.get('stype')].label;

// ------------------------------------------------------------------ page
// Corps commun des 4 pages de service, généré ici à partir de SERVICES : chaque page HTML ne contient
// que son <head> (titre, description) et <body data-page>. Inséré après l'en-tête de layout.js (chargé avant), et avant la création de la carte (#map).
document.querySelector('.appbar').insertAdjacentHTML('afterend', `
	<main class="planner">
		<aside class="panel">
			<div class="svc-head">
				<span class="badge" style="background: var(${S.color[0]})">${ICON(S.icon)}</span>
				<div>
					<h1>${S.title}</h1>
					<p>${S.desc}</p>
				</div>
			</div>

			<div class="card">
				<button class="btn btn-primary btn-block" id="btn-me">${ICON('locate')}Autour de moi</button>
				<div class="chips" id="chips"></div>
				<p class="small muted" id="status" style="margin-top: .75rem;">Chargement…</p>
			</div>

			<div class="card is-hidden" id="detail"></div>

			<div class="card">
				<div class="card-title">Les plus proches <span class="tiny" id="count" style="font-weight: 500;"></span></div>
				<ul class="poi-list" id="list"></ul>
			</div>

			<p class="tiny" style="margin: .9rem .2rem 0;">Données © contributeurs <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Distances à vol d'oiseau dans la liste.</p>
		</aside>

		<section class="mapwrap">
			<div id="map"></div>
		</section>
	</main>`);

// ------------------------------------------------------------------ carte
const map = new ol.Map({
	target: 'map',
	layers: [new ol.layer.Tile({ source: new ol.source.OSM() })],
	view: new ol.View({ center: [-4.1024, 47.996], zoom: 13, projection: 'EPSG:4326' }),
});
map.addControl(new ol.control.ScaleLine({ units: 'metric' }));

// itinéraire vers le point choisi ; pointillés entre la position / le point et le réseau routier
const routeStyle = [
	new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.95)', width: 9, lineCap: 'round', lineJoin: 'round' }) }),
	new ol.style.Style({ stroke: new ol.style.Stroke({ color: BRAND, width: 5, lineCap: 'round', lineJoin: 'round' }) }),
];
const connStyle = new ol.style.Style({ stroke: new ol.style.Stroke({ color: BRAND, width: 3, lineDash: [2, 7], lineCap: 'round' }) });
const routeSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: routeSource,
	style: f => f.get('conn') ? connStyle : routeStyle,
}));

// points (regroupés)
const { layer: poiLayer, source: poiSource } = POI.clusterLayer(SERVICE);
const singleStyle = POI.singleStyle(SERVICE);
map.addLayer(poiLayer);

// point sélectionné : anneau
const selSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: selSource, zIndex: 10,
	style: [
		new ol.style.Style({ image: new ol.style.Circle({ radius: 24, fill: new ol.style.Fill({ color: 'rgba(255,255,255,0.55)' }), stroke: new ol.style.Stroke({ color: COLOR, width: 4 }) }) }),
		...singleStyle,
	],
}));

// position de l'utilisateur
const meSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: meSource, zIndex: 11,
	style: [
		new ol.style.Style({ image: new ol.style.Circle({ radius: 18, fill: new ol.style.Fill({ color: 'rgba(37,132,230,0.18)' }) }) }),
		new ol.style.Style({ image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#2584E6' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3 }) }) }),
	],
}));

// ------------------------------------------------------------------ état
let allFeatures = [];
const active = new Set(typeKeys);
let userPos = null;
let selected = null;
let router = null, routerLoading = null;

// ------------------------------------------------------------------ données
POI.load(SERVICE).then(feats => {
	allFeatures = feats;
	buildChips();
	applyFilter();
	$('status').textContent = 'Touchez un point sur la carte ou dans la liste.';
}).catch(err => {
	$('status').textContent = 'Impossible de charger les données.';
	console.error(err);
});

function buildChips() {
	const box = $('chips');
	if (typeKeys.length < 2) { box.remove(); return; }
	const counts = {};
	allFeatures.forEach(f => { counts[f.get('stype')] = (counts[f.get('stype')] || 0) + 1; });
	box.innerHTML = typeKeys.map(k =>
		`<button class="chip is-active" data-type="${k}" aria-pressed="true">${S.types[k].plural}<span class="n">${(counts[k] || 0).toLocaleString('fr')}</span></button>`).join('');
	box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
		const k = b.dataset.type;
		if (active.has(k) && active.size === 1) return;     // garder au moins un type
		active.has(k) ? active.delete(k) : active.add(k);
		b.classList.toggle('is-active', active.has(k));
		b.setAttribute('aria-pressed', active.has(k));
		applyFilter();
	}));
}

function applyFilter() {
	poiSource.clear();
	poiSource.addFeatures(allFeatures.filter(f => active.has(f.get('stype'))));
	updateList();
}

// ------------------------------------------------------------------ liste des plus proches
function refPoint() { return userPos || map.getView().getCenter(); }

function updateList() {
	const ref = refPoint();
	const items = [];
	for (const f of allFeatures) {
		if (!active.has(f.get('stype'))) continue;
		items.push([distM(ref, f.getGeometry().getCoordinates()), f]);
	}
	items.sort((a, b) => a[0] - b[0]);
	const top = items.slice(0, LIST_SIZE);
	$('count').textContent = userPos ? 'autour de vous' : 'autour du centre de la carte';
	$('list').innerHTML = top.map(([d, f], i) => {
		const t = S.types[f.get('stype')];
		const name = f.get('name');
		return `<li><button data-i="${i}" class="${f === selected ? 'is-selected' : ''}">${DOT}
			<span class="poi-main"><strong>${escapeHtml(name || t.label)}</strong><span>${name ? t.label : t.hint}</span></span>
			<span class="poi-dist">${fmtDist(d)}</span></button></li>`;
	}).join('') || '<li class="small muted" style="padding:.6rem .4rem">Aucun point.</li>';
	$('list').querySelectorAll('button').forEach(b => b.addEventListener('click', () => select(top[+b.dataset.i][1], { pan: true })));
}
map.on('moveend', () => { if (!userPos) updateList(); });

// ------------------------------------------------------------------ sélection
map.on('singleclick', evt => {
	const hit = map.forEachFeatureAtPixel(evt.pixel, f => f, { layerFilter: l => l === poiLayer });
	if (!hit) return;
	const members = hit.get('features');
	if (members.length === 1) { select(members[0]); return; }
	const ext = ol.extent.createEmpty();
	members.forEach(m => ol.extent.extend(ext, m.getGeometry().getExtent()));
	map.getView().fit(ol.extent.buffer(ext, 0.0008), { padding: [80, 80, 80, 80], maxZoom: 18, duration: 300 });
});

function select(f, { pan = false } = {}) {
	selected = f;
	routeSource.clear();
	selSource.clear();
	selSource.addFeature(new ol.Feature(f.getGeometry().clone()));
	const c = f.getGeometry().getCoordinates();
	if (pan) map.getView().animate({ center: c, zoom: Math.max(map.getView().getZoom(), 16), duration: 300 });

	const t = S.types[f.get('stype')];
	const d = distM(refPoint(), c);
	const card = $('detail');
	card.innerHTML = `
		<div class="detail-head">${DOT}
			<div><h2>${escapeHtml(titleOf(f))}</h2><p>${f.get('name') ? t.label + ' · ' : ''}${t.hint}</p></div>
			<button class="btn btn-ghost btn-sm detail-close" aria-label="Fermer">✕</button>
		</div>
		<p class="detail-msg" id="detail-msg">${fmtDist(d)} à vol d'oiseau ${userPos ? 'de vous' : 'du centre de la carte'}.</p>
		<div class="stats is-hidden" id="detail-stats">
			<div class="stat"><div class="k">${ICON('ruler')}Distance</div><div class="v" id="d-dist"></div></div>
			<div class="stat"><div class="k">${ICON('clock')}Durée</div><div class="v" id="d-time"></div></div>
			<div class="stat"><div class="k">${ICON('up')}D+</div><div class="v" id="d-dplus"></div></div>
		</div>
		<div class="btn-row">
			<button class="btn btn-primary" id="btn-go">${ICON('route')}Itinéraire à vélo</button>
			<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${c[1].toFixed(6)}&mlon=${c[0].toFixed(6)}#map=18/${c[1].toFixed(6)}/${c[0].toFixed(6)}">OpenStreetMap</a>
		</div>`;
	card.classList.remove('is-hidden');
	card.querySelector('.detail-close').addEventListener('click', unselect);
	$('btn-go').addEventListener('click', () => routeTo(f));
	updateList();
	if (window.matchMedia('(max-width: 899px)').matches) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function unselect() {
	selected = null;
	selSource.clear();
	routeSource.clear();
	$('detail').classList.add('is-hidden');
	updateList();
}

// ------------------------------------------------------------------ position
function locate() {
	return new Promise((resolve, reject) => {
		if (!('geolocation' in navigator)) { reject(new Error('Géolocalisation indisponible')); return; }
		$('status').textContent = 'Recherche de votre position…';
		navigator.geolocation.getCurrentPosition(pos => {
			userPos = [pos.coords.longitude, pos.coords.latitude];
			meSource.clear();
			meSource.addFeature(new ol.Feature(new ol.geom.Point(userPos)));
			$('status').textContent = `Position trouvée (±${Math.round(pos.coords.accuracy)} m).`;
			updateList();
			resolve(userPos);
		}, err => {
			$('status').textContent = err.code === 1 ? 'Accès à la position refusé : la liste suit le centre de la carte.' : 'Position introuvable.';
			reject(err);
		}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
	});
}

$('btn-me').addEventListener('click', async () => {
	try {
		const p = await locate();
		map.getView().animate({ center: p, zoom: 15, duration: 300 });
	} catch (e) { /* message déjà affiché */ }
});

// si la permission est déjà accordée, on localise directement (pas de demande intempestive)
if (navigator.permissions) {
	navigator.permissions.query({ name: 'geolocation' }).then(p => {
		if (p.state === 'granted') locate().then(pos => map.getView().setCenter(pos)).catch(() => {});
	}).catch(() => {});
}

// ------------------------------------------------------------------ itinéraire local vers le point
function loadRouter() {
	if (router) return Promise.resolve(router);
	if (!routerLoading) routerLoading = BikeRouter.load(ROUTER_GRAPH_URL).then(r => (router = r));
	return routerLoading;
}

function fmtTime(s) {
	const m = Math.round(s / 60);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

async function routeTo(f) {
	const msg = $('detail-msg');
	const dest = f.getGeometry().getCoordinates();
	try {
		const start = userPos || await locate();
		msg.textContent = 'Calcul de l’itinéraire…';
		const r = await loadRouter();
		const [w, s, e, n] = r.meta.bbox_wgs84;
		const inside = p => p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
		if (!inside(start) || !inside(dest)) {
			msg.textContent = `L’itinéraire n’est disponible que dans ${ROUTER_ZONE_LABEL} pour l’instant.`;
			return;
		}
		const [a, b] = await Promise.all([r.locate(start[0], start[1], {}), r.locate(dest[0], dest[1], {})]);
		if (a.node < 0 || b.node < 0) {
			msg.textContent = `L’itinéraire n’est disponible que dans ${ROUTER_ZONE_LABEL} pour l’instant.`;
			return;
		}
		const res = await r.route(a, b, {});
		if (selected !== f) return;               // l'utilisateur a changé de point entre-temps
		if (!res) { msg.textContent = 'Aucun itinéraire trouvé.'; return; }
		routeSource.clear();
		routeSource.addFeature(new ol.Feature(new ol.geom.LineString(res.coords)));
		routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([start, res.coords[0]]), conn: true }));
		routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([res.coords[res.coords.length - 1], dest]), conn: true }));
		map.getView().fit(routeSource.getExtent(), { padding: [70, 70, 70, 70], maxZoom: 17, duration: 300 });
		$('d-dist').textContent = fmtDist(res.distance);
		$('d-time').textContent = fmtTime(res.time);
		$('d-dplus').textContent = `${Math.round(res.dplus)} m`;
		$('detail-stats').classList.remove('is-hidden');
		msg.textContent = '';
		const go = $('btn-go');
		go.outerHTML = `<a class="btn btn-primary" id="btn-go" href="${site('page/route/')}?a=${start[0].toFixed(6)},${start[1].toFixed(6)}&b=${dest[0].toFixed(6)},${dest[1].toFixed(6)}&from=me&svc=${SERVICE}">${ICON('play')}Guider</a>`;
	} catch (err) {
		msg.textContent = userPos ? 'Le calcul de l’itinéraire a échoué.' : 'Votre position est nécessaire pour calculer l’itinéraire.';
		console.warn(err);
	}
}
