// Navigation guidée, 100 % locale. Dépend de router.js (et de ol.js pour l'affichage « Carte »).
//
//  NavCore : logique pure (accroche GPS sur le tracé, progression, prochaine manœuvre,
//            détection de sortie d'itinéraire). Aucune dépendance au DOM -> testable dans Node.
//  NavUI   : écran plein, fournisseurs GPS (réel / simulation), Wake Lock, mode économe,
//            trois affichages (Carte, Schéma, Flèche).

const NAV_COLORS = {
	left: '#00E5FF',      // cyan
	right: '#FFB300',     // ambre
	straight: '#FFFFFF',
	off: '#FF2DF0',       // magenta : hors itinéraire / recalcul
	arrive: '#7CFF6B',
};
const NAV_OFF_DIST = 35;        // m : au-delà, la position est « hors tracé »
const NAV_OFF_FIXES = 2;        // nb de positions hors tracé consécutives avant recalcul
const NAV_BAND_DIST = 150;      // m : bande latérale colorée à l'approche d'un virage
const NAV_MAX_ACCURACY = 60;    // m : on ignore les positions moins précises

// ============================================================================ NavCore
class NavCore {
	constructor(router) {
		this.router = router;
		this.kx = router.mPerDegLon;
		this.ky = router.mPerDegLat;
	}

	setRoute(res, profile) {
		this.res = res;
		this.coords = res.coords;
		const n = this.coords.length;
		this.cum = new Float64Array(n);
		for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + this._d(this.coords[i - 1], this.coords[i]);
		this.total = this.cum[n - 1];
		this.man = this.router.maneuvers(res, profile);
		// distance des manœuvres recalée sur la géométrie (cum) plutôt que sur les longueurs du graphe
		for (const m of this.man) m.s = this.cum[m.coordIdx];
		this.seg = 0;
		this.s = 0;
		this.offCount = 0;
	}

	_d(a, b) { return Math.hypot((b[0] - a[0]) * this.kx, (b[1] - a[1]) * this.ky); }

	// projette p sur le segment i ; renvoie {d, s, t}
	_proj(p, i) {
		const a = this.coords[i], b = this.coords[i + 1];
		const bx = (b[0] - a[0]) * this.kx, by = (b[1] - a[1]) * this.ky;
		const px = (p[0] - a[0]) * this.kx, py = (p[1] - a[1]) * this.ky;
		const L2 = bx * bx + by * by;
		const t = L2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
		return { d: Math.hypot(px - t * bx, py - t * by), s: this.cum[i] + t * Math.sqrt(L2), t };
	}

	_match(p) {
		const n = this.coords.length - 1;
		let best = { d: Infinity, s: 0, i: 0, t: 0 };
		// d'abord autour de la dernière position connue (en privilégiant l'avant)
		for (let i = Math.max(0, this.seg - 5); i < Math.min(n, this.seg + 120); i++) {
			const r = this._proj(p, i);
			if (r.d < best.d) best = { ...r, i };
		}
		if (best.d > 60) {   // perdu : recherche sur tout le tracé
			for (let i = 0; i < n; i++) {
				const r = this._proj(p, i);
				if (r.d < best.d) best = { ...r, i };
			}
		}
		return best;
	}

	// cap du tracé (degrés) au segment i
	headingAt(i) {
		const a = this.coords[i], b = this.coords[Math.min(i + 1, this.coords.length - 1)];
		return Math.atan2((b[0] - a[0]) * this.kx, (b[1] - a[1]) * this.ky) * 180 / Math.PI;
	}

	// Prochaine manœuvre à partir de la progression s (on garde une manœuvre affichée
	// jusqu'à 8 m après l'avoir passée)
	nextManeuver(s) {
		for (const m of this.man) if (m.s > s - 8) return m;
		return this.man[this.man.length - 1];
	}

	update(lon, lat, accuracy = 10) {
		const p = [lon, lat];
		const mt = this._match(p);
		const offThreshold = Math.max(NAV_OFF_DIST, Math.min(accuracy, 50));
		if (mt.d > offThreshold) this.offCount++; else this.offCount = 0;
		const onRoute = this.offCount === 0;
		if (onRoute) { this.seg = mt.i; this.s = mt.s; }
		const next = this.nextManeuver(this.s);
		const a = this.coords[mt.i], b = this.coords[mt.i + 1];
		return {
			lon, lat, accuracy,
			matched: [a[0] + (b[0] - a[0]) * mt.t, a[1] + (b[1] - a[1]) * mt.t],
			distFromRoute: mt.d,
			onRoute,
			needsReroute: this.offCount >= NAV_OFF_FIXES,
			s: this.s,
			seg: this.seg,
			heading: this.headingAt(this.seg),
			next,
			distToNext: Math.max(0, next.s - this.s),
			remaining: Math.max(0, this.total - this.s),
			arrived: next.type === 'arrive' && next.s - this.s < 25,
		};
	}

	// état estimé sans GPS (mode économe, GPS en pause) : on avance de ds sur le tracé
	estimate(ds) {
		const next = this.nextManeuver(this.s);
		const s = Math.min(this.s + ds, next.s - 150);   // jamais trop près du virage par estimation
		return { estimated: true, s, next, distToNext: Math.max(0, next.s - s), remaining: Math.max(0, this.total - s),
			onRoute: true, heading: this.headingAt(this.seg), seg: this.seg };
	}
}

// ============================================================================ Flèches (SVG)
function navArrowSVG(m, color, size = 96) {
	const sw = 11;   // épaisseur du trait
	const head = (x, y, a) => {   // pointe de flèche en (x, y) orientée selon a (degrés, 0 = haut)
		const r = a * Math.PI / 180, dx = Math.sin(r), dy = -Math.cos(r);
		const tip = [x + dx * 14, y + dy * 14], l = [x - dy * 13, y + dx * 13], rr = [x + dy * 13, y - dx * 13];
		return `<polygon points="${tip} ${l} ${rr}" fill="${color}"/>`;
	};
	let body = '';
	if (!m) return '';
	if (m.type === 'arrive') {
		body = `<path d="M50 95 L50 50" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
			<circle cx="50" cy="32" r="18" fill="${color}"/>`;
	} else if (m.type === 'roundabout') {
		const a = m.angle * Math.PI / 180;
		const ex = 50 + Math.sin(a) * 20, ey = 45 - Math.cos(a) * 20;
		const tx = 50 + Math.sin(a) * 36, ty = 45 - Math.cos(a) * 36;
		body = `<circle cx="50" cy="45" r="20" fill="none" stroke="${color}" stroke-width="7"/>
			<path d="M50 95 L50 65" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
			<path d="M${ex} ${ey} L${tx} ${ty}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
			${head(tx, ty, m.angle)}
			<text x="50" y="52" text-anchor="middle" font-size="20" font-weight="bold" fill="${color}" font-family="sans-serif">${m.exit}</text>`;
	} else if (Math.abs(m.angle) >= 170) {   // demi-tour (par la gauche)
		body = `<path d="M65 95 L65 45 A15 15 0 0 0 35 45 L35 68" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>
			${head(35, 72, 180)}`;
	} else {
		const a = m.angle * Math.PI / 180;
		const ex = 50 + Math.sin(a) * 34, ey = 50 - Math.cos(a) * 34;
		body = `<path d="M50 95 L50 50 L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
			${head(ex, ey, m.angle)}`;
	}
	return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

function navFmtDist(m) {
	if (m < 100) return `${Math.round(m / 5) * 5} m`;
	if (m < 1000) return `${Math.round(m / 10) * 10} m`;
	return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

// ============================================================================ Fournisseurs GPS
class RealGPS {
	constructor() { this.id = null; }
	get active() { return this.id !== null; }
	start(onFix, onError) {
		if (this.id !== null || !('geolocation' in navigator)) return;
		this.id = navigator.geolocation.watchPosition(onFix, onError,
			{ enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
	}
	stop() { if (this.id !== null) { navigator.geolocation.clearWatch(this.id); this.id = null; } }
}

// Simulation : avance le long du tracé à vitesse constante (temps réel, même GPS coupé)
class SimGPS {
	constructor(core, speed = 18) { this.core = core; this.speed = speed; this.t0 = performance.now(); this.timer = null; }
	get active() { return this.timer !== null; }
	start(onFix) {
		if (this.timer) return;
		const emit = () => {
			const c = this.core, s = Math.min(c.total, this.speed * (performance.now() - this.t0) / 1000);
			let i = 0;
			while (i < c.cum.length - 2 && c.cum[i + 1] < s) i++;
			const a = c.coords[i], b = c.coords[i + 1], L = c.cum[i + 1] - c.cum[i];
			const t = L > 0 ? (s - c.cum[i]) / L : 0;
			onFix({ coords: { longitude: a[0] + (b[0] - a[0]) * t, latitude: a[1] + (b[1] - a[1]) * t, accuracy: 5, speed: this.speed }, timestamp: Date.now() });
		};
		emit();
		this.timer = setInterval(emit, 1000);
	}
	stop() { clearInterval(this.timer); this.timer = null; }
}

// ============================================================================ NavUI
// ctx : { router, map, profile(), reroute(lon, lat) -> Promise<res|null>, showRoute(res), onExit() }
class NavUI {
	constructor(ctx) {
		this.ctx = ctx;
		this.core = new NavCore(ctx.router);
		this.el = id => document.getElementById(id);
		this.eco = false;
		this.display = 'map';
		this.speed = 0;            // m/s lissée
		this.lastFix = null;
		this.lastRerouteAt = 0;
		this.wakeLock = null;
		this.pauseTimer = null;
		this.estTimer = null;
		this.state = null;
		this._bindUI();
		document.addEventListener('visibilitychange', () => this._onVisibility());
	}

	_bindUI() {
		this.el('nav-exit').addEventListener('click', () => this.stop());
		this.el('nav-eco').addEventListener('click', () => this.setEco(!this.eco));
		document.querySelectorAll('[data-navdisplay]').forEach(b =>
			b.addEventListener('click', () => this.setDisplay(b.dataset.navdisplay)));
		window.addEventListener('resize', () => this.state && this.render());
	}

	// ------------------------------------------------------------------ cycle de vie
	start(res, { simulate = false } = {}) {
		this.core.setRoute(res, this.ctx.profile());
		this.gps = simulate ? new SimGPS(this.core) : new RealGPS();
		this.simulate = simulate;
		this.el('nav').classList.remove('is-hidden');
		document.documentElement.classList.add('nav-open');
		this.el('nav-sim').classList.toggle('is-hidden', !simulate);
		this.setEco(this.eco);
		this._startGPS();
		this._requestWakeLock();
		this.state = { ...this.core.estimate(0), waiting: true };
		this.render();
	}

	stop() {
		this._stopGPS();
		clearTimeout(this.pauseTimer); clearInterval(this.estTimer);
		this.pauseTimer = this.estTimer = null;
		if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
		this.el('nav').classList.add('is-hidden');
		document.documentElement.classList.remove('nav-open');
		this._showBand(null);
		if (this.posLayer) { this.ctx.map.removeLayer(this.posLayer); this.posLayer = this.posFeature = null; }
		this.ctx.map.setTarget('map');
		this.ctx.onExit();
	}

	setEco(on) {
		this.eco = on;
		this.el('nav').classList.toggle('eco', on);
		this.el('nav-eco').textContent = on ? 'Économe : oui' : 'Économe : non';
		this.el('nav-displays').classList.toggle('is-hidden', !on);
		this.setDisplay(on ? (this.display === 'map' ? 'schema' : this.display) : 'map');
		if (!on) this._resumeGPS();
	}

	setDisplay(d) {
		this.display = d;
		document.querySelectorAll('[data-navdisplay]').forEach(b => b.classList.toggle('is-selected', b.dataset.navdisplay === d));
		this.el('nav-map').classList.toggle('is-hidden', d !== 'map');
		this.el('nav-schema').classList.toggle('is-hidden', d !== 'schema');
		this.el('nav-big').classList.toggle('is-hidden', d !== 'arrow');
		this.el('nav-banner').classList.toggle('is-hidden', d === 'arrow');
		if (d === 'map') {
			this.ctx.map.setTarget('nav-map');
			this.ctx.map.updateSize();
			this._ensurePosLayer();
		} else {
			this.ctx.map.setTarget(null);   // plus aucun rendu de carte
		}
		if (this.state) this.render();
	}

	// ------------------------------------------------------------------ GPS
	_startGPS() {
		this.gps.start(pos => this._onFix(pos), err => this._onGPSError(err));
		this._setGpsStatus('search');
	}
	_stopGPS() { this.gps && this.gps.stop(); }

	_onGPSError(err) {
		console.warn('GPS', err);
		this._setGpsStatus('error', err.code === 1 ? 'GPS refusé' : 'pas de signal');
	}

	_onFix(pos) {
		const c = pos.coords;
		if (c.accuracy > NAV_MAX_ACCURACY) { this._setGpsStatus('weak', `±${Math.round(c.accuracy)} m`); return; }
		const now = performance.now();
		const st = this.core.update(c.longitude, c.latitude, c.accuracy);
		// vitesse : celle du GPS si fournie, sinon progression sur le tracé
		let v = (c.speed != null && !isNaN(c.speed)) ? c.speed : null;
		if (v === null && this.lastFix && st.onRoute) {
			const dt = (now - this.lastFix.t) / 1000;
			if (dt > 0.5) v = Math.max(0, Math.min(20, (st.s - this.lastFix.s) / dt));
		}
		if (v !== null) this.speed = this.speed ? 0.7 * this.speed + 0.3 * v : v;
		this.lastFix = { t: now, s: st.s, lon: c.longitude, lat: c.latitude };
		this._setGpsStatus('ok', `±${Math.round(c.accuracy)} m`);

		if (st.needsReroute && now - this.lastRerouteAt > 8000) {
			this.lastRerouteAt = now;
			this.state = { ...st, rerouting: true };
			this.render();
			// recalcul asynchrone (tuiles du graphe chargées au besoin) : appliqué à la dernière position connue
			Promise.resolve(this.ctx.reroute(c.longitude, c.latitude)).then(res => {
				if (!res || this.el('nav').classList.contains('is-hidden')) return;
				this.core.setRoute(res, this.ctx.profile());
				this.ctx.showRoute(res);
				const p = this.lastFix || { lon: c.longitude, lat: c.latitude };
				this.state = this.core.update(p.lon, p.lat, c.accuracy);
				this.render();
			}).catch(err => console.warn('recalcul impossible', err));
		} else {
			this.state = st;
		}
		this.render();
		if (this.state.arrived) { this._stopGPS(); this._setGpsStatus('paused', 'arrivé'); return; }
		this._maybePauseGPS();
	}

	// Mode économe : coupe le GPS tant que le prochain virage est loin
	_maybePauseGPS() {
		const st = this.state;
		if (!this.eco || !st.onRoute || st.distToNext < 800 || this.speed < 1) return;
		const vmax = Math.max(this.speed * 1.6, 8);              // marge : descente, accélération
		const pause = Math.min(180, (st.distToNext - 400) / vmax);
		if (pause < 20) return;
		this._stopGPS();
		this._setGpsStatus('paused', `${Math.round(pause)} s`);
		const t0 = performance.now(), s0 = st.s, v = this.speed;
		clearInterval(this.estTimer);
		this.estTimer = setInterval(() => {      // affichage estimé toutes les 5 s
			this.core.s = s0;
			this.state = this.core.estimate(v * (performance.now() - t0) / 1000);
			this.render();
		}, 5000);
		clearTimeout(this.pauseTimer);
		this.pauseTimer = setTimeout(() => this._resumeGPS(), pause * 1000);
	}

	_resumeGPS() {
		clearTimeout(this.pauseTimer); clearInterval(this.estTimer);
		this.pauseTimer = this.estTimer = null;
		if (this.gps && !this.gps.active && !(this.state && this.state.arrived) && !this.el('nav').classList.contains('is-hidden')) {
			this._startGPS();
		}
	}

	_onVisibility() {
		if (this.el('nav').classList.contains('is-hidden')) return;
		if (document.visibilityState === 'visible') {
			this._requestWakeLock();
			if (!this.pauseTimer) this._resumeGPS();
		} else {
			this._stopGPS();     // le navigateur le couperait de toute façon
		}
	}

	async _requestWakeLock() {
		try {
			if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
		} catch (e) { console.warn('Wake Lock', e); }
	}

	_setGpsStatus(kind, txt = '') {
		const el = this.el('nav-gps');
		el.dataset.kind = kind;
		el.textContent = { search: 'GPS…', ok: `GPS ${txt}`, weak: `GPS ${txt} !`, paused: `GPS veille ${txt}`, error: txt }[kind];
	}

	// ------------------------------------------------------------------ rendu
	_color(st) {
		if (st.rerouting || !st.onRoute) return NAV_COLORS.off;
		if (st.next.type === 'arrive') return NAV_COLORS.arrive;
		return NAV_COLORS[st.next.side] || NAV_COLORS.straight;
	}

	render() {
		const st = this.state;
		if (!st) return;
		const color = this._color(st);
		let text, dist;
		if (st.waiting) { text = 'Recherche du GPS…'; dist = ''; }
		else if (st.rerouting) { text = 'Recalcul de l’itinéraire…'; dist = ''; }
		else if (!st.onRoute) { text = 'Hors itinéraire'; dist = navFmtDist(st.distFromRoute); }
		else if (st.arrived) { text = 'Vous êtes arrivé'; dist = ''; }
		else { text = st.next.text; dist = (st.estimated ? '≈ ' : '') + navFmtDist(st.distToNext); }

		const arrow = st.onRoute && !st.rerouting && !st.waiting ? st.next : null;
		this.el('nav-arrow').innerHTML = navArrowSVG(arrow, color, 84);
		this.el('nav-dist').textContent = dist;
		this.el('nav-dist').style.color = color;
		this.el('nav-text').textContent = text;

		// bottom : reste + heure d'arrivée
		const res = this.core.res;
		const tLeft = res.time * (st.remaining / Math.max(1, this.core.total));
		const eta = new Date(Date.now() + tLeft * 1000);
		this.el('nav-remain').textContent = `${navFmtDist(st.remaining)} · ${eta.getHours()}h${String(eta.getMinutes()).padStart(2, '0')}`;

		const near = st.onRoute && !st.waiting && !st.arrived && st.next.type !== 'arrive'
			&& st.distToNext < NAV_BAND_DIST && st.next.side !== 'straight';
		this._showBand(near ? st.next.side : (!st.onRoute && !st.waiting ? 'off' : null));

		if (this.display === 'map') this._renderMap(st);
		else if (this.display === 'schema') this._renderSchema(st, color);
		else this._renderBig(st, color, text, dist);
	}

	_showBand(side) {
		const band = this.el('nav-band');
		band.className = side ? `band-${side}` : '';
	}

	// --- affichage Carte (OpenLayers, tuiles OSM : consomme réseau + GPU)
	_ensurePosLayer() {
		if (this.posFeature) return;
		this.posFeature = new ol.Feature(new ol.geom.Point([0, 0]));
		this.posLayer = new ol.layer.Vector({
			source: new ol.source.Vector({ features: [this.posFeature] }), zIndex: 20,
			style: new ol.style.Style({ image: new ol.style.Circle({ radius: 9,
				fill: new ol.style.Fill({ color: '#1e88e5' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3 }) }) }),
		});
		this.ctx.map.addLayer(this.posLayer);
	}
	_renderMap(st) {
		if (st.lon === undefined) return;
		this._ensurePosLayer();
		this.posFeature.getGeometry().setCoordinates([st.lon, st.lat]);
		const v = this.ctx.map.getView();
		v.setCenter([st.lon, st.lat]);
		if (v.getZoom() < 16) v.setZoom(17);
	}

	// --- affichage Schéma : notre propre graphe sur fond noir, orienté dans le sens de la marche
	_buildGrid() {
		const r = this.ctx.router, f = r.f, CELL = 200;
		const [w, s] = r.meta.bbox_wgs84;
		const X = lon => (lon - w) * r.mPerDegLon, Y = lat => (lat - s) * r.mPerDegLat;
		const grid = new Map();
		const edges = [];                        // tronçons des tuiles chargées seulement
		for (const t of r.tiles) if (t.loaded) for (let e = t.e0; e < t.e0 + t.ec; e++) edges.push(e);
		for (const e of edges) {
			let x0 = Math.min(X(r.lon[f.edge_u[e]]), X(r.lon[f.edge_v[e]])), x1 = Math.max(X(r.lon[f.edge_u[e]]), X(r.lon[f.edge_v[e]]));
			let y0 = Math.min(Y(r.lat[f.edge_u[e]]), Y(r.lat[f.edge_v[e]])), y1 = Math.max(Y(r.lat[f.edge_u[e]]), Y(r.lat[f.edge_v[e]]));
			for (let k = f.geom_off[e]; k < f.geom_off[e + 1]; k++) {
				const x = X(f.geom_lon[k] * 1e-6), y = Y(f.geom_lat[k] * 1e-6);
				if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
			}
			for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
				for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
					const key = cx * 100000 + cy;
					let l = grid.get(key); if (!l) grid.set(key, l = []);
					l.push(e);
				}
		}
		this.grid = { grid, CELL, X, Y, version: r.version };
	}

	_renderSchema(st, color) {
		const cv = this.el('nav-schema');
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const W = cv.clientWidth, H = cv.clientHeight;
		if (!W || !H) return;
		if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
		const ctx = cv.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
		if (!this.grid || this.grid.version !== this.ctx.router.version) this._buildGrid();   // nouvelles tuiles
		const r = this.ctx.router, f = r.f, { grid, CELL, X, Y } = this.grid;
		const core = this.core;
		// position affichée : point accroché sur le tracé (ou estimé)
		let cLon, cLat;
		if (st.matched && st.onRoute) [cLon, cLat] = st.matched;
		else if (st.lon !== undefined) { cLon = st.lon; cLat = st.lat; }
		else {   // estimation : point du tracé à l'abscisse s
			let i = 0; while (i < core.cum.length - 2 && core.cum[i + 1] < st.s) i++;
			const a = core.coords[i], b = core.coords[i + 1], L = core.cum[i + 1] - core.cum[i], t = L ? (st.s - core.cum[i]) / L : 0;
			cLon = a[0] + (b[0] - a[0]) * t; cLat = a[1] + (b[1] - a[1]) * t;
		}
		const cx = W / 2, cy = H * 0.68;
		const k = H / 420;                         // px par mètre : ~285 m devant, ~135 m derrière
		const th = (st.heading || 0) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
		const px = X(cLon), py = Y(cLat);
		const toScreen = (lon, lat) => {
			const dx = X(lon) - px, dy = Y(lat) - py;
			return [cx + (dx * cs - dy * sn) * k, cy - (dx * sn + dy * cs) * k];
		};
		// réseau alentour
		const R = Math.hypot(W, H) / k / 2 + CELL;
		const seen = new Set();
		ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
		ctx.beginPath();
		for (let gx = Math.floor((px - R) / CELL); gx <= Math.floor((px + R) / CELL); gx++)
			for (let gy = Math.floor((py - R) / CELL); gy <= Math.floor((py + R) / CELL); gy++) {
				const l = grid.get(gx * 100000 + gy); if (!l) continue;
				for (const e of l) {
					if (seen.has(e)) continue; seen.add(e);
					const pts = r.edgeCoords(e, false);
					let p = toScreen(pts[0][0], pts[0][1]); ctx.moveTo(p[0], p[1]);
					for (let j = 1; j < pts.length; j++) { p = toScreen(pts[j][0], pts[j][1]); ctx.lineTo(p[0], p[1]); }
				}
			}
		ctx.stroke();
		// itinéraire : partie faite en gris, reste en blanc épais
		const drawRoute = (i0, i1, style, w) => {
			if (i1 <= i0) return;
			ctx.strokeStyle = style; ctx.lineWidth = w; ctx.beginPath();
			let p = toScreen(...core.coords[i0]); ctx.moveTo(p[0], p[1]);
			for (let j = i0 + 1; j <= i1; j++) { p = toScreen(...core.coords[j]); ctx.lineTo(p[0], p[1]); }
			ctx.stroke();
		};
		const segI = st.seg || 0;
		drawRoute(0, segI + 1, '#777', 5);
		drawRoute(segI, core.coords.length - 1, '#fff', 10);
		// prochaine manœuvre
		if (st.next && st.onRoute) {
			const p = toScreen(...core.coords[st.next.coordIdx]);
			ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, 2 * Math.PI); ctx.fill();
		}
		// position : triangle jaune vers le haut
		ctx.fillStyle = st.onRoute ? '#FFEB3B' : NAV_COLORS.off;
		ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
		ctx.beginPath(); ctx.moveTo(cx, cy - 18); ctx.lineTo(cx + 13, cy + 13); ctx.lineTo(cx, cy + 6); ctx.lineTo(cx - 13, cy + 13); ctx.closePath();
		ctx.fill(); ctx.stroke();
	}

	// --- affichage Flèche : quasiment tout noir
	_renderBig(st, color, text, dist) {
		const arrow = st.onRoute && !st.rerouting && !st.waiting ? st.next : null;
		this.el('nav-big-arrow').innerHTML = navArrowSVG(arrow, color, Math.min(window.innerWidth * 0.7, 300));
		this.el('nav-big-dist').textContent = dist;
		this.el('nav-big-dist').style.color = color;
		this.el('nav-big-text').textContent = text;
		this.el('nav-big-progress').style.width = `${(100 * st.s / Math.max(1, this.core.total)).toFixed(1)}%`;
	}
}
