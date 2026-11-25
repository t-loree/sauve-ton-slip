// Planificateur d'itinéraire (page/route/). Dépend de ol.js, poi.js, router.js et nav.js.
// Région (REGIONS de router.js) choisie automatiquement : départ placé, sinon centre de la carte ;
// chaque région a son graphe et ses points de service.

const PRESETS = {
	balanced: { traffic: 1, hills: 1, steep: 1, steepThreshold: 6, unpaved: 0.5, allowDismount: true, allowSteps: false },
	quiet: { traffic: 2, hills: 2, steep: 2, steepThreshold: 5, unpaved: 1, allowDismount: true, allowSteps: false },
	fast: { traffic: 0.2, hills: 0.5, steep: 0.3, steepThreshold: 8, unpaved: 1, allowDismount: false, allowSteps: false },
	vtt: { traffic: 1.5, hills: 0.5, steep: 0.3, steepThreshold: 10, unpaved: 0, allowDismount: true, allowSteps: false },
};

const $ = id => document.getElementById(id);
const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const statusEl = $('status');
const mapWrap = document.querySelector('.mapwrap');

// ------------------------------------------------------------------ carte
const map = new ol.Map({
	target: 'map',
	layers: [new ol.layer.Tile({ source: new ol.source.OSM() })],
	view: new ol.View({ center: REGIONS[lastRegion()].center, zoom: 13, projection: 'EPSG:4326' }),
});
map.addControl(new ol.control.ScaleLine({ units: 'metric' }));

const coverageSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: coverageSource,
	style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(14,110,107,0.55)', width: 2, lineDash: [8, 6] }) }),
}));

function gradeColor(g) {
	const a = Math.abs(g);
	if (g < -3) return '#2E7DB5';        // descente
	if (a <= 3) return '#3C9A5F';        // plat
	if (g <= 6) return '#E3B23C';
	if (g <= 10) return '#E07B2E';
	return '#C8402F';                    // > 10 %
}

const refSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: refSource,
	style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(90,90,90,0.55)', width: 4, lineDash: [10, 6] }) }),
}));

const routeSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: routeSource,
	// un seul liseré blanc sous tout le tracé (zIndex 0), puis les tronçons colorés par pente (zIndex 1)
	style: f => f.get('conn')
		? new ol.style.Style({ zIndex: 2, stroke: new ol.style.Stroke({ color: '#13293D', width: 2.5, lineDash: [2, 7], lineCap: 'round' }) })
		: f.get('casing')
		? new ol.style.Style({ zIndex: 0, stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.95)', width: 9, lineCap: 'round', lineJoin: 'round' }) })
		: new ol.style.Style({ zIndex: 1, stroke: new ol.style.Stroke({
			color: f.get('color'), width: 5, lineCap: f.get('dismount') ? 'butt' : 'round', lineJoin: 'round',
			lineDash: f.get('dismount') ? [4, 6] : undefined,
		}) }),
}));

const markerSource = new ol.source.Vector();
const viaStyle = new ol.style.Style({
	image: new ol.style.Circle({ radius: 7, fill: new ol.style.Fill({ color: '#fff' }),
		stroke: new ol.style.Stroke({ color: cssVar('--brand', '#0E6E6B'), width: 3 }) }),
});
const markerStyle = label => label === 'V' ? viaStyle : new ol.style.Style({
	image: new ol.style.Circle({
		radius: 11,
		fill: new ol.style.Fill({ color: label === 'A' ? cssVar('--brand', '#0E6E6B') : cssVar('--danger', '#C8402F') }),
		stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }),
	}),
	text: new ol.style.Text({ text: label, fill: new ol.style.Fill({ color: '#fff' }), font: '700 12px system-ui, sans-serif' }),
});
const markerLayer = new ol.layer.Vector({ source: markerSource, zIndex: 10, style: f => markerStyle(f.get('label')) });
map.addLayer(markerLayer);

const hoverSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({
	source: hoverSource, zIndex: 11,
	style: new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: '#13293D' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }) }) }),
}));

const markers = { A: null, B: null };
// points de passage entre A et B, dans l'ordre du trajet (marqueurs « V » de markerSource)
const vias = [];
const VIA_MAX = 6;
function clearVias() { vias.splice(0).forEach(v => markerSource.removeFeature(v)); }
// indice du tronçon (A→P1 = 0, P1→P2 = 1…) le plus proche d'un point de l'itinéraire affiché
function legAt(coord) {
	if (!lastRoute?.legEnds) return vias.length;
	const c = lastRoute.coords, kx = Math.cos(coord[1] * Math.PI / 180);
	let best = 0, bd = Infinity;
	for (let i = 0; i < c.length; i++) {
		const d = ((c[i][0] - coord[0]) * kx) ** 2 + (c[i][1] - coord[1]) ** 2;
		if (d < bd) { bd = d; best = i; }
	}
	const k = lastRoute.legEnds.findIndex(e => e >= best);
	return k < 0 ? vias.length : k;
}
function addVia(coord, leg = legAt(coord)) {
	if (vias.length >= VIA_MAX) { statusEl.textContent = `${VIA_MAX} points de passage au plus.`; return null; }
	const f = new ol.Feature({ geometry: new ol.geom.Point(coord), label: 'V' });
	markerSource.addFeature(f);
	vias.splice(leg, 0, f);
	return f;
}
const pointLabel = { A: null };
function updatePoints() {
	const set = (id, on, txtOn, txtOff) => { $(id).classList.toggle('set', on); $(id).querySelector('span').textContent = on ? txtOn : txtOff; };
	set('pt-a', !!markers.A, pointLabel.A || 'Départ placé', 'Départ : touchez la carte');
	set('pt-b', !!markers.B, 'Arrivée placée', 'Arrivée : touchez la carte');
}
function setMarker(label, coord) {
	if (label === 'A') {
		pointLabel.A = null;
		const r = regionAt(...coord);
		if (r && r !== region) {                     // départ dans une autre région : son graphe, arrivée effacée
			if (markers.B) { markerSource.removeFeature(markers.B); markers.B = null; }
			clearVias();
			useRegion(r);
		}
	}
	queueMicrotask(updatePoints);
	if (!markers[label]) {
		markers[label] = new ol.Feature({ geometry: new ol.geom.Point(coord), label });
		markerSource.addFeature(markers[label]);
	} else {
		markers[label].getGeometry().setCoordinates(coord);
	}
}

const translate = new ol.interaction.Translate({ layers: [markerLayer] });
translate.on('translateend', () => computeRoute());
map.addInteraction(translate);

let draggingMarker = false;
translate.on('translatestart', () => { draggingMarker = true; });
translate.on('translateend', () => { setTimeout(() => { draggingMarker = false; }, 0); });

// Souris : tirer l'itinéraire crée un point de passage sous le pointeur ; pendant le glisser, pointillés vers
// les points voisins, calcul au relâcher. Au doigt, toucher l'itinéraire ajoute le point (puis on le fait
// glisser) : tirer la ligne se confondrait avec le déplacement de la carte.
const previewSource = new ol.source.Vector();
map.addLayer(new ol.layer.Vector({ source: previewSource, zIndex: 9,
	style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#13293D', width: 2.5, lineDash: [6, 6] }) }) }));
const surItineraire = px => map.hasFeatureAtPixel(px, { layerFilter: l => l.getSource() === routeSource, hitTolerance: 6 });
const surMarqueur = px => map.hasFeatureAtPixel(px, { layerFilter: l => l === markerLayer, hitTolerance: 4 });
let tire = null;   // { f : point de passage tiré, avant, apres : coordonnées des points voisins }
map.addInteraction(new ol.interaction.Pointer({
	handleDownEvent(evt) {
		const e = evt.originalEvent;
		if (e.pointerType !== 'mouse' || e.button !== 0) return false;
		if (!router || !markers.A || !markers.B || !lastRoute || !$('nav').classList.contains('is-hidden')) return false;
		if (surMarqueur(evt.pixel) || !surItineraire(evt.pixel)) return false;
		const f = addVia(evt.coordinate);
		if (!f) return false;
		const pts = [markers.A, ...vias, markers.B], i = pts.indexOf(f);
		tire = { f, avant: pts[i - 1].getGeometry().getCoordinates(), apres: pts[i + 1].getGeometry().getCoordinates() };
		draggingMarker = true;
		return true;   // l'événement s'arrête ici : la carte ne se déplace pas
	},
	handleDragEvent(evt) {
		tire.f.getGeometry().setCoordinates(evt.coordinate);
		previewSource.clear();
		previewSource.addFeature(new ol.Feature(new ol.geom.LineString([tire.avant, evt.coordinate, tire.apres])));
	},
	handleUpEvent() {
		previewSource.clear();
		tire = null;
		// un simple clic sur la ligne passe aussi par ici : on ignore le « singleclick » qui suit (il retirerait le point)
		setTimeout(() => { draggingMarker = false; }, 400);
		computeRoute();
		return false;
	},
}));
// curseur : main sur l'itinéraire et les marqueurs (ordinateur)
map.on('pointermove', evt => {
	if (evt.dragging || evt.originalEvent.pointerType !== 'mouse') return;
	map.getTargetElement().style.cursor = surMarqueur(evt.pixel) ? 'grab'
		: (markers.A && markers.B && lastRoute && surItineraire(evt.pixel)) ? 'copy' : '';
});

// ------------------------------------------------------------------ points de service sur la carte
// Une couche groupée par service, créée et chargée au premier affichage ; choix mémorisé.
const POI_KEY = 'cyclo.route.poi';
const poiLayers = {};                       // id -> { layer, source, feats }
let poiOn = new Set();
try { poiOn = new Set(JSON.parse(localStorage.getItem(POI_KEY)) || []); } catch (e) { /* stockage indisponible */ }

// points du service pour la région courante
async function loadPoi(id) {
	const l = poiLayers[id], r = region;
	l.region = r;
	l.feats = null;
	l.source.clear();
	try {
		const feats = await POI.load(id, r);
		if (l.region === r) l.feats = feats;
	} catch (err) {
		console.error(err);
		statusEl.textContent = `Impossible de charger : ${SERVICES[id].title}.`;
	}
}

// les sanitaires du fichier « eau » sont les toilettes : pas de doublon si les deux sont affichés
function fillPoi(id) {
	const l = poiLayers[id];
	if (!l || !l.feats) return;
	const hideToilets = id === 'water' && poiOn.has('toilet');
	l.source.clear();
	l.source.addFeatures(hideToilets ? l.feats.filter(f => f.get('stype') !== 'toilet') : l.feats);
}

async function showPoi(id, on) {
	on ? poiOn.add(id) : poiOn.delete(id);
	try { localStorage.setItem(POI_KEY, JSON.stringify([...poiOn])); } catch (e) { /* idem */ }
	if (on && !poiLayers[id]) {
		poiLayers[id] = POI.clusterLayer(id, { distance: 36, radius: 13, zIndex: 5 });
		map.addLayer(poiLayers[id].layer);
	}
	if (on && poiLayers[id] && poiLayers[id].region !== region && region) await loadPoi(id);
	if (poiLayers[id]) { poiLayers[id].layer.setVisible(poiOn.has(id)); fillPoi(id); }
	if (id === 'toilet') fillPoi('water');
}

(function buildPoiChips() {
	const box = $('poi-chips');
	box.innerHTML = Object.keys(SERVICES).map(id =>
		`<button class="chip${poiOn.has(id) ? ' is-active' : ''}" data-svc="${id}" aria-pressed="${poiOn.has(id)}">`
		+ `<span class="dot" style="background:${POI.color(id)}"></span>${SERVICES[id].title}</button>`).join('');
	box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
		const on = !poiOn.has(b.dataset.svc);
		b.classList.toggle('is-active', on);
		b.setAttribute('aria-pressed', on);
		showPoi(b.dataset.svc, on);
	}));
	[...poiOn].forEach(id => SERVICES[id] ? showPoi(id, true) : poiOn.delete(id));
})();

map.on('singleclick', evt => {
	if (draggingMarker || !router) return;
	const mk = map.forEachFeatureAtPixel(evt.pixel, f => f, { layerFilter: l => l === markerLayer, hitTolerance: 4 });
	if (mk) {   // toucher un point de passage le retire ; A et B se déplacent en les faisant glisser
		if (mk.get('label') === 'V') { markerSource.removeFeature(mk); vias.splice(vias.indexOf(mk), 1); computeRoute(); }
		return;
	}
	// toucher l'itinéraire (A et B placés) ajoute un point de passage, qu'on fait ensuite glisser
	if (markers.A && markers.B && lastRoute && map.hasFeatureAtPixel(evt.pixel, { layerFilter: l => l.getSource() === routeSource, hitTolerance: 8 })) {
		if (addVia(evt.coordinate)) computeRoute();
		return;
	}
	// clic sur un point de service : groupe => zoom ; point isolé => départ / arrivée posé dessus
	let coord = evt.coordinate;
	const hit = map.forEachFeatureAtPixel(evt.pixel, f => f, { layerFilter: l => !!l.get('svc') });
	if (hit) {
		const members = hit.get('features');
		const view = map.getView();
		if (members.length > 1 && view.getZoom() < view.getMaxZoom() - 1) {
			const ext = ol.extent.createEmpty();
			members.forEach(m => ol.extent.extend(ext, m.getGeometry().getExtent()));
			view.fit(ext, { padding: [80, 80, 80, 80], maxZoom: 18, duration: 300 });
			return;
		}
		coord = members[0].getGeometry().getCoordinates();
	}
	if (!markers.A || (markers.A && markers.B)) {
		if (markers.B) { markerSource.removeFeature(markers.B); markers.B = null; updatePoints(); }
		clearVias();
		routeSource.clear(); refSource.clear(); clearResults();
		setMarker('A', coord);
		statusEl.textContent = 'Touchez la carte pour placer l’arrivée.';
	} else {
		setMarker('B', coord);
		computeRoute();
	}
});

// ------------------------------------------------------------------ profil (formulaire)
function readProfile() {
	return {
		traffic: +$('p-traffic').value,
		hills: +$('p-hills').value,
		steep: +$('p-steep').value,
		steepThreshold: +$('p-thr').value,
		unpaved: +$('p-unpaved').value,
		allowDismount: $('p-dismount').checked,
		allowSteps: $('p-steps').checked,
	};
}
function writeProfile(p) {
	$('p-traffic').value = p.traffic; $('p-hills').value = p.hills;
	$('p-steep').value = p.steep; $('p-unpaved').value = p.unpaved; $('p-thr').value = p.steepThreshold;
	$('p-dismount').checked = p.allowDismount; $('p-steps').checked = p.allowSteps;
	updateSliderLabels();
}
// curseur 0..21 : 0 à 100 % par pas de 5, puis illimité
const readDetour = () => { const i = +$('p-detour').value; return i > 20 ? Infinity : i * 0.05; };
const flatMode = () => $('p-flat').checked;

function updateSliderLabels() {
	for (const id of ['p-traffic', 'p-hills', 'p-steep', 'p-unpaved']) {
		$(id + '-v').textContent = (+$(id).value).toFixed(1);
	}
	$('p-thr-v').textContent = `${(+$('p-thr').value).toFixed(1)} %`;
	const d = readDetour();
	$('p-detour-v').textContent = d === Infinity ? 'illimité' : `+${Math.round(d * 100)} %`;
	// en mode plat, le poids du dénivelé est choisi automatiquement
	$('p-hills').disabled = flatMode();
	$('p-detour').disabled = !flatMode();
}

// regroupe les recalculs pendant qu'on bouge un curseur (le mode plat fait ~10 A*)
let pending = false;
function scheduleCompute() {
	if (pending) return;
	pending = true;
	requestAnimationFrame(() => { pending = false; computeRoute(); });
}

document.querySelectorAll('#profile input:not([id^="s-"])').forEach(el => el.addEventListener('input', () => {
	updateSliderLabels();
	document.querySelectorAll('[data-preset]').forEach(b => b.classList.remove('is-active'));
	scheduleCompute();
}));
document.querySelectorAll('#flatbox input').forEach(el => el.addEventListener('input', () => {
	updateSliderLabels();
	scheduleCompute();
}));
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
	document.querySelectorAll('[data-preset]').forEach(b => b.classList.remove('is-active'));
	btn.classList.add('is-active');
	writeProfile(PRESETS[btn.dataset.preset]);
	computeRoute();
}));
writeProfile(PRESETS.balanced);

// vitesses du cycliste : seulement le temps estimé (pas l'itinéraire), gardées sur l'appareil
const SPEED_IDS = { flat: 's-flat', up: 's-up', down: 's-down' };
function readSpeeds() {
	return { flat: +$('s-flat').value, up: +$('s-up').value, down: +$('s-down').value };
}
function updateSpeedLabels() {
	const s = readSpeeds();
	$('s-flat-v').textContent = `${s.flat} km/h`;
	$('s-up-v').textContent = `${s.up} km/h`;
	$('s-down-v').textContent = s.down >= 60 ? 'à fond !' : `${s.down} km/h`;
}
{
	const s = routerSavedSpeeds();
	for (const [k, id] of Object.entries(SPEED_IDS)) $(id).value = s[k];
	updateSpeedLabels();
}
let speedTimer = 0;
Object.values(SPEED_IDS).forEach(id => $(id).addEventListener('input', () => {
	updateSpeedLabels();
	const s = readSpeeds();
	try { localStorage.setItem(ROUTER_SPEEDS_KEY, JSON.stringify(s)); } catch (e) { /* tant pis */ }
	if (router) router.speeds = s;
	clearTimeout(speedTimer);
	speedTimer = setTimeout(() => { if (lastRoute) computeRoute(); }, 150);
}));

// ------------------------------------------------------------------ calcul
let router = null;
let nav = null;
let region = null;

function drawRoute(r) {
	routeSource.clear();
	routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(r.coords), casing: true }));
	// pointillés entre les marqueurs A / B et les points d'accroche sur le réseau
	if (markers.A && markers.B && $('nav').classList.contains('is-hidden')) {   // pas pendant la navigation (recalculs)
		routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([markers.A.getGeometry().getCoordinates(), r.coords[0]]), conn: true }));
		routeSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([r.coords[r.coords.length - 1], markers.B.getGeometry().getCoordinates()]), conn: true }));
		vias.forEach((v, k) => r.legEnds && routeSource.addFeature(new ol.Feature({
			geometry: new ol.geom.LineString([v.getGeometry().getCoordinates(), r.coords[r.legEnds[k]]]), conn: true })));
	}
	routeSource.addFeatures(r.segments.map(s => new ol.Feature({
		geometry: new ol.geom.LineString(s.coords),
		color: gradeColor(s.grade),
		dismount: s.cls === 'footway' || s.cls === 'steps',
	})));
	r.line = new ol.geom.LineString(r.coords);
}

// ------------------------------------------------------------------ navigation
// venu de Trône Finder (?svc=toilet) : avertissement adapté à l'urgence
const depuisToilettes = new URLSearchParams(location.search).get('svc') === 'toilet';

async function startNav(simulate) {
	if (!lastRoute || !nav) return;
	if (!simulate) {
		await avertir(depuisToilettes
			? { emoji: '🩲', titre: 'Mieux vaut un slip sale…', texte: '… que finir dans le fossé. Regarde la route, pas le téléphone !', bouton: 'Compris, j’y vais' }
			: { emoji: '👀', titre: 'Regarde la route, pas ton téléphone !', texte: 'Le guidage te prévient avant chaque virage : garde les yeux sur la chaussée.', bouton: 'C’est parti' });
	}
	refSource.clear();
	hoverSource.clear();
	nav.start(lastRoute, { simulate });
}

// itinéraire depuis une position quelconque vers la destination actuelle (recalcul en route)
async function rerouteFrom(lon, lat) {
	const profile = readProfile();
	const dst = lastRoute.dst;
	const src = await router.locate(lon, lat, profile);
	if (src.e < 0) return null;
	// points de passage encore devant : ceux dont le tronçon finit après le point de l'itinéraire le plus proche
	let reste = [];
	if (lastRoute.vias?.length) {
		const c = lastRoute.coords, kx = Math.cos(lat * Math.PI / 180);
		let ici = 0, bd = Infinity;
		c.forEach((p, i) => { const d = ((p[0] - lon) * kx) ** 2 + (p[1] - lat) ** 2; if (d < bd) { bd = d; ici = i; } });
		reste = lastRoute.vias.filter((v, k) => lastRoute.legEnds[k] > ici);
	}
	const res = await router.routeVia([src, ...reste, dst], profile, flatMode() ? readDetour() : null);
	const r = flatMode() ? res?.route : res;
	if (r) lastRoute = r;
	return r;
}

$('btn-nav').addEventListener('click', () => startNav(false));
$('btn-sim').addEventListener('click', () => startNav(true));

// départ = position GPS actuelle
$('btn-here').addEventListener('click', () => {
	if (!('geolocation' in navigator)) { statusEl.textContent = 'Géolocalisation indisponible.'; return; }
	statusEl.textContent = 'Recherche de votre position…';
	navigator.geolocation.getCurrentPosition(pos => {
		const c = [pos.coords.longitude, pos.coords.latitude];
		setMarker('A', c);
		pointLabel.A = 'Ma position';
		map.getView().setCenter(c);
		if (markers.B) computeRoute();
		else statusEl.textContent = 'Départ sur votre position. Touchez la carte pour l’arrivée.';
	}, err => {
		statusEl.textContent = err.code === 1 ? 'Accès à la position refusé.' : 'Position introuvable.';
	}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
});

let lastRoute = null;

function fmtTime(s) {
	const m = Math.round(s / 60);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

function clearResults() {
	lastRoute = null;
	$('results').classList.add('is-hidden');
	drawProfile();
}

// Les tuiles du graphe se chargent pendant le calcul : seul le dernier calcul lancé s'affiche.
let computeSeq = 0;
async function computeRoute() {
	if (!router || !markers.A || !markers.B) return;
	if ([markers.A, ...vias, markers.B].some(m => regionAt(...m.getGeometry().getCoordinates()) !== region)) {
		routeSource.clear(); refSource.clear(); clearResults();
		++computeSeq; statusEl.classList.remove('calcul'); mapWrap.classList.remove('calcul');   // un calcul encore en cours ne s'affichera pas
		statusEl.textContent = `Départ et arrivée doivent être tous deux dans ${REGIONS[region].label}.`;
		return;
	}
	const seq = ++computeSeq;
	const profile = readProfile();
	const [la, pa] = markers.A.getGeometry().getCoordinates();
	const [lb, pb] = markers.B.getGeometry().getCoordinates();
	const tiles0 = router.loadedTiles;
	// indicateur tout de suite, puis une image pour que le navigateur l'affiche avant le calcul : le mode plat
	// (plusieurs A*) occupe la page 1 à 3 s et empêcherait sinon tout affichage, minuteur compris
	statusEl.textContent = 'Calcul de l’itinéraire…';
	statusEl.classList.add('calcul');
	mapWrap.classList.add('calcul');   // carte grisée + cycliste animé si le calcul dure (CSS, après 0,6 s)
	await new Promise(res => requestAnimationFrame(() => setTimeout(res)));
	if (seq !== computeSeq) return;
	const slow = setTimeout(() => { if (seq === computeSeq) statusEl.textContent = 'Chargement du réseau…'; }, 300);
	let sa, sb, r, flat = null, sv = [];
	try {
		[sa, sb, ...sv] = await Promise.all([router.locate(la, pa, profile), router.locate(lb, pb, profile),
			...vias.map(v => router.locate(...v.getGeometry().getCoordinates(), profile))]);
		if (sa.node < 0 || sb.node < 0 || sv.some(v => v.node < 0)) { r = null; }
		else if (flatMode()) {
			flat = await router.routeVia([sa, ...sv, sb], profile, readDetour());
			r = flat && flat.route;
		} else {
			r = await router.routeVia([sa, ...sv, sb], profile);
		}
	} catch (err) {
		console.error(err);
		if (seq === computeSeq) statusEl.textContent = 'Réseau indisponible (hors ligne ?).';
		return;
	} finally {
		clearTimeout(slow);
		if (seq === computeSeq) { statusEl.classList.remove('calcul'); mapWrap.classList.remove('calcul'); }
	}
	if (seq !== computeSeq) return;
	routeSource.clear();
	refSource.clear();
	if (!r) {
		statusEl.textContent = sa.node < 0 || sb.node < 0 || sv.some(v => v.node < 0) ? `Point hors de la zone couverte (${REGIONS[region].label}).` : 'Aucun itinéraire trouvé avec ce profil.';
		clearResults();
		return;
	}
	lastRoute = r;
	drawRoute(r);
	const view = map.getView(), ext = routeSource.getExtent();
	if (!ol.extent.containsExtent(view.calculateExtent(map.getSize()), ext)) {
		view.fit(ext, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 300 });
	}

	$('r-dist').textContent = `${(r.distance / 1000).toFixed(2)} km`;
	$('r-dplus').textContent = `${Math.round(r.dplus)} m`;
	$('r-dminus').textContent = `${Math.round(r.dminus)} m`;
	$('r-time').textContent = fmtTime(r.time);
	const snap = ` · accroche A ${Math.round(sa.dist)} m, B ${Math.round(sb.dist)} m`
		+ ` · ${router.loadedTiles} tuiles (${router.loadedTiles - tiles0} nouvelles, ${(router.loadedBytes / 1e6).toFixed(1)} Mo)`;
	if (flat) {
		const ref = flat.ref;
		if (flat.route !== ref) refSource.addFeature(new ol.Feature(new ol.geom.LineString(ref.coords)));
		const dd = r.distance - ref.distance, dz = r.dplus - ref.dplus;
		const net = Math.max(0, r.profile[r.profile.length - 1][1] - r.profile[0][1]);
		const netTxt = `<br><span class="has-text-grey">D+ minimal possible (arrivée − départ) : ${Math.round(net)} m</span>`;
		$('r-compare').innerHTML = flat.route === ref
			? `Aucun itinéraire plus plat dans ce détour (normal : ${(ref.distance / 1000).toFixed(2)} km, D+ ${Math.round(ref.dplus)} m).` + netTxt
			: `Itinéraire normal : ${(ref.distance / 1000).toFixed(2)} km, D+ ${Math.round(ref.dplus)} m → `
			+ `<strong>${dz <= 0 ? '−' : '+'}${Math.abs(Math.round(dz))} m de D+</strong> pour `
			+ `${dd >= 0 ? '+' : '−'}${(Math.abs(dd) / 1000).toFixed(2)} km (${dd >= 0 ? '+' : '−'}${Math.abs(Math.round(dd / ref.distance * 100))} %)` + netTxt;
		$('r-perf').textContent = `${flat.ms.toFixed(0)} ms · ${flat.runs} calculs A* · poids dénivelé λ=${flat.lambda.toFixed(1)}` + snap;
	} else {
		$('r-compare').textContent = '';
		$('r-perf').textContent = `${r.ms.toFixed(1)} ms · ${r.explored.toLocaleString('fr')} nœuds explorés` + snap;
	}
	$('results').classList.remove('is-hidden');
	statusEl.textContent = (vias.length ? `${vias.length} point${vias.length > 1 ? 's' : ''} de passage. ` : '')
		+ 'Faites glisser A, B ou un point de passage. Touchez l’itinéraire pour ajouter un détour, un point de passage pour le retirer. Toucher ailleurs recommence.';
	drawProfile();
}

// ------------------------------------------------------------------ profil altimétrique (canvas)
const canvas = $('elev');
function drawProfile(hoverX = null) {
	const dpr = window.devicePixelRatio || 1;
	const W = canvas.clientWidth, H = canvas.clientHeight;
	canvas.width = W * dpr; canvas.height = H * dpr;
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, W, H);
	if (!lastRoute) return;
	const P = lastRoute.elev;
	const padL = 40, padR = 8, padT = 8, padB = 20;
	const dmax = P[P.length - 1][0] || 1;
	let zmin = Infinity, zmax = -Infinity;
	for (const [, z] of P) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
	if (zmax - zmin < 20) { const m = (zmax + zmin) / 2; zmin = m - 10; zmax = m + 10; }
	const X = d => padL + d / dmax * (W - padL - padR);
	const Y = z => padT + (1 - (z - zmin) / (zmax - zmin)) * (H - padT - padB);

	ctx.font = '11px system-ui, sans-serif';
	ctx.fillStyle = cssVar('--ink-3', '#7D8C98'); ctx.strokeStyle = cssVar('--line', '#E6DFD2'); ctx.lineWidth = 1;
	for (const z of [zmin, (zmin + zmax) / 2, zmax]) {
		ctx.beginPath(); ctx.moveTo(padL, Y(z)); ctx.lineTo(W - padR, Y(z)); ctx.stroke();
		ctx.fillText(`${Math.round(z)} m`, 2, Y(z) + 4);
	}
	ctx.fillText(`${(dmax / 1000).toFixed(1)} km`, W - padR - 40, H - 4);
	ctx.fillText('0', padL, H - 4);

	for (let i = 1; i < P.length; i++) {
		const [d0, z0] = P[i - 1], [d1, z1] = P[i];
		ctx.fillStyle = gradeColor(d1 > d0 ? (z1 - z0) / (d1 - d0) * 100 : 0);
		ctx.beginPath();
		const x1 = X(d1) + 0.75;
		ctx.moveTo(X(d0), H - padB); ctx.lineTo(X(d0), Y(z0)); ctx.lineTo(x1, Y(z1)); ctx.lineTo(x1, H - padB);
		ctx.closePath(); ctx.fill();
	}
	if (hoverX !== null) {
		ctx.strokeStyle = cssVar('--ink', '#13293D');
		ctx.beginPath(); ctx.moveTo(hoverX, padT); ctx.lineTo(hoverX, H - padB); ctx.stroke();
	}
	canvas._x2d = x => Math.min(dmax, Math.max(0, (x - padL) / (W - padL - padR) * dmax));
}
canvas.addEventListener('mousemove', ev => {
	if (!lastRoute) return;
	const x = ev.offsetX;
	const d = canvas._x2d(x);
	drawProfile(x);
	hoverSource.clear();
	hoverSource.addFeature(new ol.Feature(new ol.geom.Point(lastRoute.line.getCoordinateAt(d / lastRoute.distance))));
	const P = lastRoute.elev;
	let i = 1; while (i < P.length - 1 && P[i][0] < d) i++;
	const [d0, z0] = P[i - 1], [d1, z1, cls] = P[i];
	const z = d1 > d0 ? z0 + (z1 - z0) * (d - d0) / (d1 - d0) : z1;
	const g = d1 > d0 ? (z1 - z0) / (d1 - d0) * 100 : 0;
	$('elev-info').textContent = `${(d / 1000).toFixed(2)} km · ${Math.round(z)} m · pente ${g.toFixed(1)} % · ${cls}`;
});
canvas.addEventListener('mouseleave', () => { hoverSource.clear(); drawProfile(); $('elev-info').textContent = ''; });
window.addEventListener('resize', () => drawProfile());

// ------------------------------------------------------------------ région et graphe
// Graphe de la région (index seulement, tuiles à la demande), contour couvert, points de service affichés.
async function useRegion(id) {
	if (id === region) return;
	region = id;
	rememberRegion(id);
	router = null;                               // pas de calcul pendant le chargement
	lastRoute = null;
	routeSource.clear(); refSource.clear(); coverageSource.clear(); clearResults();
	Object.keys(poiLayers).forEach(k => { if (poiOn.has(k)) loadPoi(k).then(() => { fillPoi(k); if (k === 'toilet') fillPoi('water'); }); });
	let r;
	try {
		r = await routerFor(id);
	} catch (err) {
		if (region === id) statusEl.textContent = 'Impossible de charger le graphe.';
		console.error(err);
		return;
	}
	if (region !== id) return;                   // une autre région demandée entre-temps
	router = r;
	router.speeds = readSpeeds();
	const [w, s, e, n] = router.meta.bbox_wgs84;
	// zone couverte : contour du graphe (meta.contour, pipeline 03), sinon son emprise
	const rings = router.meta.contour || [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
	rings.forEach(ring => coverageSource.addFeature(new ol.Feature(new ol.geom.Polygon([ring]))));
	$('graph-info').textContent = `Réseau local : ${router.E.toLocaleString('fr')} tronçons dans ${REGIONS[id].label}, `
		+ `en ${router.tiles.length} tuiles chargées au besoin.`;
	if (nav) nav.setRouter(router);
	else nav = new NavUI({
		router, map,
		profile: readProfile,
		reroute: rerouteFrom,
		showRoute: drawRoute,
		onExit: () => {
			if (lastRoute) { drawRoute(lastRoute); drawProfile(); }
			map.getView().fit(routeSource.getExtent(), { padding: [40, 40, 40, 40], maxZoom: 16 });
		},
	});
	if (markers.A && markers.B) computeRoute();
	else statusEl.textContent = markers.A ? 'Touchez la carte pour placer l’arrivée.' : 'Touchez la carte pour placer le départ, ou partez de votre position.';
}

// carte déplacée vers une autre région, sans départ placé : on change de région
map.on('moveend', () => {
	if (markers.A || !$('nav').classList.contains('is-hidden')) return;
	const r = regionAt(...map.getView().getCenter());
	if (r && r !== region) useRegion(r);
});

(async () => {
	// lien depuis une page de service : ?a=lon,lat&b=lon,lat[&via=lon,lat;lon,lat][&from=me][&svc=<service>]
	const q = new URLSearchParams(location.search);
	const parse = v => { const c = (v || '').split(',').map(Number); return c.length === 2 && c.every(Number.isFinite) ? c : null; };
	const qa = parse(q.get('a')), qb = parse(q.get('b'));
	const start = (qa && regionAt(...qa)) || lastRegion();
	if (qa && qb) {
		map.getView().setCenter(qa);
		setMarker('A', qa);
		setMarker('B', qb);
		(q.get('via') || '').split(';').map(parse).filter(Boolean).slice(0, VIA_MAX).forEach(c => addVia(c, vias.length));
		if (q.get('from') === 'me') pointLabel.A = 'Ma position';
	}
	await useRegion(start);
})();
