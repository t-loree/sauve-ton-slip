// Calcul d'itinéraire vélo 100 % côté client, sur le graphe en tuiles produit par
// pipeline/03_build_graph.py (web-site/data/graph/<nom>/meta.json + t/<i>_<j>.bin), A* pondéré.


// Régions servies (pipeline/config.py : ZONES), choisies automatiquement d'après la position ou la carte.
// Chacune a son graphe (data/graph/<id>/) et ses POI (data/poi/<id>/). bbox = emprise WGS84 [O, S, E, N]
// un peu plus large que le graphe ; center = vue par défaut. SITE (layout.js) = racine du site, absente sous Node.
const REGIONS = {
	bretagne: { label: 'la Bretagne', bbox: [-5.3, 47.2, -0.9, 49.0], center: [-4.1024, 47.996] },
	reunion: { label: 'La Réunion', bbox: [55.1, -21.5, 56.0, -20.75], center: [55.4504, -20.8789] },
};
const REGION_KEY = 'sts-region';
const REGION_ROOT = typeof SITE !== 'undefined' ? SITE : '';
const regionGraphUrl = id => `${REGION_ROOT}data/graph/${id}`;

// région qui contient le point, sinon null
function regionAt(lon, lat) {
	for (const [id, r] of Object.entries(REGIONS)) {
		const [w, s, e, n] = r.bbox;
		if (lon >= w && lon <= e && lat >= s && lat <= n) return id;
	}
	return null;
}

// dernière région vue (mémorisée), Bretagne par défaut
function lastRegion() {
	try { const r = localStorage.getItem(REGION_KEY); if (REGIONS[r]) return r; } catch (e) { /* stockage indisponible */ }
	return 'bretagne';
}
function rememberRegion(id) { try { localStorage.setItem(REGION_KEY, id); } catch (e) { /* idem */ } }

// un BikeRouter par région, chargé une fois (index seulement ; les tuiles viennent à la demande)
const ROUTERS = {};
function routerFor(id) {
	return ROUTERS[id] || (ROUTERS[id] = BikeRouter.load(regionGraphUrl(id)).catch(err => { delete ROUTERS[id]; throw err; }));
}
const ROUTER_REGIONS_LABEL = Object.values(REGIONS).map(r => r.label).join(' et ');   // messages « hors zone »
const ROUTER_MAX_SNAP_M = 3000;                      // au-delà, le point est hors du réseau (node = -1)

const ROUTER_SPEEDS_KMH = {           // vitesse de base selon le revêtement
	paved: 18, paved_rough: 13, compacted: 14, unpaved: 10, unknown: 12,
};
const ROUTER_DISMOUNT_KMH = 5;        // pied à terre
const ROUTER_STEPS_KMH = 2;           // escaliers, vélo à la main
const ROUTER_CLIMB_S_PER_M = 10;      // ≈ 360 m de D+ à l'heure en plus du plat
// Vitesses du cycliste pour le temps estimé (km/h, sur route revêtue), réglables dans « Façon de rouler » :
// plat ; montée = vitesse dans une côte à 6 % (vitesse verticale constante : 2 fois plus lent à 12 %) ;
// descente = vitesse max, atteinte dès 6 % de pente. Ne changent pas le choix de l'itinéraire.
const ROUTER_DEFAULT_SPEEDS = { flat: 18, up: 10, down: 35 };
const ROUTER_SPEEDS_KEY = 'sts-vitesses';
function routerSavedSpeeds() {
	try {
		const v = JSON.parse(localStorage.getItem(ROUTER_SPEEDS_KEY) || 'null');
		if (v && [v.flat, v.up, v.down].every(Number.isFinite)) return v;
	} catch (e) { /* hors navigateur ou stockage bloqué */ }
	return { ...ROUTER_DEFAULT_SPEEDS };
}
// Mode « le plus plat » : D+ considérés égaux en deçà de cet écart (bruit du MNT et du tracé OSM,
// ±2 m sur ~160 m, cf. etudes/microrelief/RESULTATS.md) ; on prend alors le plus court.
const ROUTER_FLAT_TIE_REL = 0.02;     // 2 % du D+ minimal
const ROUTER_FLAT_TIE_MIN = 1;        // m, au moins

// Préférence par classe de voie, pour un « évitement du trafic » de 1.
// Multiplie le temps : < 1 = recherché, > 1 = évité.
const ROUTER_CLASS_PREF = {
	cycleway: 0.8, path: 1.0, track: 1.0, residential: 1.0, service: 1.05,
	unclassified: 1.1, tertiary: 1.3, secondary: 1.8, primary: 2.5, trunk: 4.0,
	footway: 1.0, steps: 1.0,
};

const ROUTER_DEFAULT_PROFILE = {
	traffic: 1,         // 0 = indifférent au type de route, 2 = fuit les grands axes
	hills: 1,           // multiplicateur de l'effort de montée (0 = plat ou pas, on s'en fiche)
	steep: 1,           // force de la pénalité au-delà du seuil (0 = aucune, 5 = quasi interdit)
	steepThreshold: 6,  // seuil de pente (%) au-delà duquel on pénalise
	unpaved: 0.5,       // pénalité supplémentaire chemins non revêtus
	allowDismount: true,
	allowSteps: false,
};

class MinHeap {
	constructor() { this.k = []; this.v = []; }
	get size() { return this.k.length; }
	push(key, val) {
		const k = this.k, v = this.v;
		let i = k.length;
		k.push(key); v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (k[p] <= key) break;
			k[i] = k[p]; v[i] = v[p]; i = p;
		}
		k[i] = key; v[i] = val;
	}
	pop() {
		const k = this.k, v = this.v;
		const top = v[0];
		const lk = k.pop(), lv = v.pop();
		const n = k.length;
		if (n > 0) {
			let i = 0;
			while (true) {
				let c = 2 * i + 1;
				if (c >= n) break;
				if (c + 1 < n && k[c + 1] < k[c]) c++;
				if (k[c] >= lk) break;
				k[i] = k[c]; v[i] = v[c]; i = c;
			}
			k[i] = lk; v[i] = lv;
		}
		return top;
	}
}

class BikeRouter {
	// Graphe en tuiles (format 3, pipeline/03_build_graph.py) : meta.json est l'index ; les tuiles
	// t/<i>_<j>.bin sont chargées à la demande (autour d'un point, puis au fil de l'A*).
	// fetchTile(key) -> Promise<ArrayBuffer> peut être remplacé (tests Node).
	static async load(baseUrl, fetchTile) {
		const meta = await fetch(`${baseUrl}/meta.json`)
			.then(r => { if (!r.ok) throw new Error(`meta.json HTTP ${r.status}`); return r.json(); });
		return new BikeRouter(meta, fetchTile || (key => fetch(`${baseUrl}/t/${key}.bin.gz`)
			.then(r => { if (!r.ok) throw new Error(`tuile ${key} HTTP ${r.status}`); return r.arrayBuffer(); })
			.then(BikeRouter.gunzip)));
	}

	// Tuiles stockées en gzip : décompressées ici, sauf si le serveur l'a déjà fait (Content-Encoding)
	static async gunzip(buf) {
		const b = new Uint8Array(buf, 0, 2);
		if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
		return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
	}

	constructor(meta, fetchTile) {
		if (meta.format !== 3) throw new Error(`format de graphe ${meta.format} non pris en charge`);
		this.meta = meta;
		this.fetchTile = fetchTile;
		const N = this.N = meta.nodes, E = this.E = meta.edges, G = meta.geom, A = meta.adj, NB = meta.climb_bins, P = meta.prof || 0;
		this.speeds = routerSavedSpeeds();
		// tableaux globaux, remplis tuile par tuile (les plages d'une tuile sont contiguës)
		this.f = {
			node_lon: new Int32Array(N), node_lat: new Int32Array(N), node_z: new Int16Array(N), node_comp: new Uint8Array(N),
			edge_u: new Uint32Array(E), edge_v: new Uint32Array(E), edge_len: new Uint32Array(E),
			edge_dp: new Uint16Array(E), edge_dm: new Uint16Array(E), edge_gf: new Uint8Array(E), edge_gb: new Uint8Array(E),
			edge_climb: new Uint16Array(E * 2 * NB), edge_cls: new Uint8Array(E), edge_sur: new Uint8Array(E), edge_flg: new Uint8Array(E),
			geom_off: new Uint32Array(E + 1), geom_lon: new Int32Array(G), geom_lat: new Int32Array(G),
			adj_off: new Uint32Array(N + 1), adj: new Uint32Array(A),
			// profil simplifié (points intérieurs) : position = fraction de longueur depuis u × 65535, altitude dm
			prof_off: new Uint32Array(E + 1), prof_pos: new Uint16Array(P), prof_z: new Int16Array(P),
		};
		this.lon = new Float64Array(N);
		this.lat = new Float64Array(N);
		this.nodeLoaded = new Uint8Array(N);      // nœud d'une tuile chargée (adjacence disponible)
		this.edgeLoaded = new Uint8Array(E);
		const cols = meta.tile_cols;
		this.tiles = meta.tiles.map((t, idx) => ({ idx, ...Object.fromEntries(cols.map((c, k) => [c, t[k]])) }));
		this.tileByKey = new Map(this.tiles.map(t => [t.key, t]));
		this.loading = new Map();                  // idx -> Promise
		this.loadedTiles = 0;
		this.loadedBytes = 0;
		this.version = 0;                          // incrémenté à chaque tuile chargée (affichage Schéma)
		const lat0 = (meta.bbox_wgs84[1] + meta.bbox_wgs84[3]) / 2;
		this.mPerDegLat = 111132.9;
		this.mPerDegLon = 111319.5 * Math.cos(lat0 * Math.PI / 180);
		this.F = meta.flags;
		this.classIdx = Object.fromEntries(meta.classes.map((c, i) => [c, i]));
	}

	// ------------------------------------------------------------------ tuiles
	tileKeyAt(lon, lat) {
		const g = this.meta.grid;
		return `${Math.floor((lon - g.lon0) / g.dlon)}_${Math.floor((lat - g.lat0) / g.dlat)}`;
	}

	// tuile contenant le nœud n (ou le tronçon e) : recherche dichotomique sur les plages
	_tileOf(id, start) {
		const t = this.tiles;
		let lo = 0, hi = t.length - 1;
		while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m][start] <= id) lo = m; else hi = m - 1; }
		return t[lo];
	}
	tileOfNode(n) { return this._tileOf(n, 'n0'); }
	tileOfEdge(e) { return this._tileOf(e, 'e0'); }

	loadTile(t) {
		if (t.loaded) return Promise.resolve();
		if (!this.loading.has(t.idx)) {
			this.loading.set(t.idx, this.fetchTile(t.key).then(buf => { this._install(t, buf); this.loading.delete(t.idx); }));
		}
		return this.loading.get(t.idx);
	}

	async loadTiles(list) {
		const todo = [...new Set(list)].filter(t => t && !t.loaded);
		for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(t => this.loadTile(t)));
	}

	// tuiles (existantes) dans un rayon de `ring` tuiles autour du point
	tilesAround(lon, lat, ring = 1) {
		const g = this.meta.grid, i0 = Math.floor((lon - g.lon0) / g.dlon), j0 = Math.floor((lat - g.lat0) / g.dlat);
		const out = [];
		for (let i = i0 - ring; i <= i0 + ring; i++)
			for (let j = j0 - ring; j <= j0 + ring; j++) { const t = this.tileByKey.get(`${i}_${j}`); if (t) out.push(t); }
		return out;
	}

	_install(t, buf) {
		const hl = new DataView(buf).getUint32(0, true);
		const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
		const ctor = { int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array };
		const a = {};
		for (const [name, type, off, len] of head.fields) a[name] = new ctor[type](buf, off, len);
		const f = this.f, { n0, nc, e0, ec, g0, a0 } = t, NB2 = 2 * this.meta.climb_bins;
		// nœuds
		f.node_lon.set(a.node_lon, n0); f.node_lat.set(a.node_lat, n0); f.node_z.set(a.node_z, n0); f.node_comp.set(a.node_comp, n0);
		for (let k = 0; k < nc; k++) { this.lon[n0 + k] = a.node_lon[k] * 1e-6; this.lat[n0 + k] = a.node_lat[k] * 1e-6; }
		// extrémités situées dans d'autres tuiles : coordonnées seulement (pour l'heuristique et le dessin)
		for (let k = 0; k < a.xnode_id.length; k++) {
			const n = a.xnode_id[k];
			if (this.nodeLoaded[n]) continue;
			f.node_lon[n] = a.xnode_lon[k]; f.node_lat[n] = a.xnode_lat[k]; f.node_z[n] = a.xnode_z[k]; f.node_comp[n] = a.xnode_comp[k];
			this.lon[n] = a.xnode_lon[k] * 1e-6; this.lat[n] = a.xnode_lat[k] * 1e-6;
		}
		// tronçons
		for (const k of ['edge_u', 'edge_v', 'edge_len', 'edge_dp', 'edge_dm', 'edge_gf', 'edge_gb', 'edge_cls', 'edge_sur', 'edge_flg'])
			f[k].set(a[k], e0);
		f.edge_climb.set(a.edge_climb, e0 * NB2);
		// géométrie : offsets globaux, écarts Int16 cumulés depuis le nœud u (toujours dans cette tuile)
		for (let k = 0; k <= ec; k++) f.geom_off[e0 + k] = g0 + a.geom_off[k];
		for (let k = 0; k < ec; k++) {
			const u = a.edge_u[k];
			let x = f.node_lon[u], y = f.node_lat[u];
			for (let p = a.geom_off[k]; p < a.geom_off[k + 1]; p++) {
				x += a.geom_dlon[p]; y += a.geom_dlat[p];
				f.geom_lon[g0 + p] = x; f.geom_lat[g0 + p] = y;
			}
		}
		// profil simplifié (absent des graphes plus anciens : le tronçon reste une droite entre ses nœuds)
		if (a.prof_off && t.p0 !== undefined) {
			for (let k = 0; k <= ec; k++) f.prof_off[e0 + k] = t.p0 + a.prof_off[k];
			f.prof_pos.set(a.prof_pos, t.p0); f.prof_z.set(a.prof_z, t.p0);
		} else {
			f.prof_off.fill(f.prof_off[e0], e0, e0 + ec + 1);
		}
		// adjacence (index globaux de tronçons, y compris ceux des tuiles voisines)
		for (let k = 0; k <= nc; k++) f.adj_off[n0 + k] = a0 + a.adj_off[k];
		f.adj.set(a.adj, a0);
		this.nodeLoaded.fill(1, n0, n0 + nc);
		this.edgeLoaded.fill(1, e0, e0 + ec);
		t.loaded = true;
		this.loadedTiles++;
		this.loadedBytes += buf.byteLength;
		this.version++;
	}

	// --- profil -> tables de coût précalculées par classe / revêtement
	compileProfile(p) {
		p = { ...ROUTER_DEFAULT_PROFILE, ...p };
		const cls = this.meta.classes, sur = this.meta.surfaces;
		const classMult = new Float64Array(cls.length);
		const classMultLane = new Float64Array(cls.length);
		cls.forEach((c, i) => {
			const base = ROUTER_CLASS_PREF[c] ?? 1;
			classMult[i] = Math.max(0.3, 1 + (base - 1) * p.traffic);
			// une bande cyclable réduit de 60 % la pénalité trafic
			classMultLane[i] = base > 1 ? 1 + (classMult[i] - 1) * 0.4 : classMult[i];
		});
		const surfSecPerM = new Float64Array(sur.length);
		sur.forEach((s, i) => {
			const rough = (s === 'unpaved' || s === 'compacted' || s === 'unknown') ? 1 + p.unpaved * (s === 'compacted' ? 0.5 : 1) : 1;
			surfSecPerM[i] = 3.6 / ROUTER_SPEEDS_KMH[s] * rough;
		});
		// Pénalité (s par mètre de montée) pour chaque tranche de pente de l'histogramme,
		// moyennée sur la tranche : 0.2 * steep * (x + x²), x = dépassement du seuil / 2 %.
		const bins = this.meta.grade_bins;
		const steepPen = new Float64Array(bins.length);
		for (let b = 0; b < bins.length; b++) {
			const lo = bins[b], hi = bins[b + 1] ?? lo + 4;
			let acc = 0;
			for (let k = 0; k < 8; k++) {
				const x = Math.max(0, lo + (k + 0.5) / 8 * (hi - lo) - p.steepThreshold) / 2;
				acc += 0.2 * p.steep * (x + x * x);
			}
			steepPen[b] = acc / 8;
		}
		const minMult = Math.min(...classMult, ...classMultLane);
		const vmax = Math.max(...Object.values(ROUTER_SPEEDS_KMH)) / 3.6;
		return {
			p, classMult, classMultLane, surfSecPerM, steepPen, nb: bins.length,
			// heuristique A* admissible : coût minimal possible par mètre à vol d'oiseau
			hPerM: minMult / vmax * 0.99,
			steps: this.classIdx.steps,
		};
	}

	// Coût (secondes « ressenties ») du tronçon e parcouru dans le sens rev (false: u->v), ou Infinity
	edgeCost(e, rev, cp) {
		const f = this.f, F = this.F;
		const flg = f.edge_flg[e];
		if (rev && (flg & F.oneway)) return Infinity;
		const c = f.edge_cls[e];
		const len = f.edge_len[e] * 0.1;
		let t;
		if (c === cp.steps) {
			if (!cp.p.allowSteps) return Infinity;
			t = len * 3.6 / ROUTER_STEPS_KMH;
		} else if (flg & F.dismount) {
			if (!cp.p.allowDismount) return Infinity;
			t = len * 3.6 / ROUTER_DISMOUNT_KMH;
		} else {
			t = len * cp.surfSecPerM[f.edge_sur[e]];
		}
		t *= (flg & F.cyclelane) ? cp.classMultLane[c] : cp.classMult[c];
		const dplus = (rev ? f.edge_dm[e] : f.edge_dp[e]) * 0.1;
		t += dplus * ROUTER_CLIMB_S_PER_M * cp.p.hills;
		// pentes raides : seuls les mètres de montée au-delà du seuil sont pénalisés
		// (steep=1, seuil+2 % => +0.4 s/m ≈ x3 sur le plat ; steep=5 => x10)
		if (cp.p.steep > 0) {
			const nb = cp.nb, base = e * 2 * nb + (rev ? nb : 0), h = f.edge_climb;
			for (let b = 0; b < nb; b++) {
				const m = h[base + b];
				if (m) t += m * cp.steepPen[b];
			}
		}
		return t;
	}

	// Temps réaliste (sans préférences), pour l'affichage, selon les vitesses du cycliste (this.speeds).
	// edge_climb donne, par sens, les mètres de route par tranche de pente (≥ 3 %) : montée dans le sens
	// parcouru, descente dans l'autre ; le reste est compté comme du plat.
	edgeTime(e, rev) {
		const f = this.f, F = this.F;
		const flg = f.edge_flg[e], c = f.edge_cls[e];
		const len = f.edge_len[e] * 0.1;
		if (c === this.classIdx.steps) return len * 3.6 / ROUTER_STEPS_KMH;
		if (flg & F.dismount) return len * 3.6 / ROUTER_DISMOUNT_KMH;
		const sp = this.speeds;
		const k = ROUTER_SPEEDS_KMH[this.meta.surfaces[f.edge_sur[e]]] / ROUTER_SPEEDS_KMH.paved;   // revêtement
		const vFlat = sp.flat * k / 3.6, vUp6 = sp.up * k / 3.6, vDown = Math.max(sp.down * k, sp.flat * k) / 3.6;
		const nb = this.meta.climb_bins, h = f.edge_climb, bins = this.meta.grade_bins;
		const up = e * 2 * nb + (rev ? nb : 0), down = e * 2 * nb + (rev ? 0 : nb);
		let t = 0, slopeLen = 0;
		for (let b = 0; b < nb; b++) {
			const g = b + 1 < nb ? (bins[b] + bins[b + 1]) / 2 : bins[b] + 2;   // pente au milieu de la tranche
			const mu = h[up + b], md = h[down + b];
			if (mu) { t += mu / Math.min(vFlat, vUp6 * 6 / g); slopeLen += mu; }
			if (md) { t += md / (vFlat + (vDown - vFlat) * Math.min(1, (g - 2) / 4)); slopeLen += md; }
		}
		return t + Math.max(0, len - slopeLen) / vFlat;
	}

	distM(a, b) {
		const dx = (this.lon[a] - this.lon[b]) * this.mPerDegLon;
		const dy = (this.lat[a] - this.lat[b]) * this.mPerDegLat;
		return Math.sqrt(dx * dx + dy * dy);
	}

	// ------------------------------------------------------------------ accroche
	// bit de node_comp pour ce profil (plus grande composante connexe praticable, précalculée)
	compBit(profile) {
		const p = { ...ROUTER_DEFAULT_PROFILE, ...profile };
		return 1 << ((p.allowDismount ? 1 : 0) + (p.allowSteps ? 2 : 0));
	}

	// Nœud le plus proche appartenant au réseau principal praticable avec ce profil, parmi les tuiles
	// chargées autour du point. Charger d'abord : await router.locate(...) le fait.
	nearestNode(lon, lat, profile) {
		const bit = this.compBit(profile);
		let best = -1, bestD = Infinity;
		for (const t of this.tilesAround(lon, lat, 1)) {
			if (!t.loaded) continue;
			for (let i = t.n0; i < t.n0 + t.nc; i++) {
				if (!(this.f.node_comp[i] & bit)) continue;
				const dx = (this.lon[i] - lon) * this.mPerDegLon;
				const dy = (this.lat[i] - lat) * this.mPerDegLat;
				const d = dx * dx + dy * dy;
				if (d < bestD) { best = i; bestD = d; }
			}
		}
		return { node: best, dist: Math.sqrt(bestD) };
	}

	// tuiles dont le centre est à moins de 6 km + 15 % de la distance du segment [a, b] ([lon, lat])
	corridor(a, b) {
		const g = this.meta.grid;
		const ax = a[0] * this.mPerDegLon, ay = a[1] * this.mPerDegLat;
		const bx = b[0] * this.mPerDegLon, by = b[1] * this.mPerDegLat;
		const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
		const half = 6000 + 0.15 * Math.sqrt(vx * vx + vy * vy);
		return this.tiles.filter(t => {
			const [i, j] = t.key.split('_').map(Number);
			const cx = (g.lon0 + (i + 0.5) * g.dlon) * this.mPerDegLon, cy = (g.lat0 + (j + 0.5) * g.dlat) * this.mPerDegLat;
			const s = Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / l2));
			return Math.hypot(cx - ax - s * vx, cy - ay - s * vy) < half;
		});
	}

	// Point du réseau le plus proche : projection sur la géométrie des tronçons praticables avec ce profil
	// (extrémités dans la composante principale, au moins un sens permis). Sur une grande route, les nœuds
	// sont espacés de centaines de mètres : s'accrocher au nœud le plus proche faisait faire des allers-retours.
	// Renvoie { e, frac (position le long du tronçon, 0 = u, 1 = v), lon, lat, dist, node (extrémité la plus
	// proche) } ; e = -1 si rien dans les tuiles chargées.
	nearestEdge(lon, lat, profile) {
		const f = this.f, bit = this.compBit(profile), cp = this.compileProfile(profile);
		const kx = this.mPerDegLon, ky = this.mPerDegLat;
		let best = { e: -1, dist: Infinity };
		for (const t of this.tilesAround(lon, lat, 1)) {
			if (!t.loaded) continue;
			for (let e = t.e0; e < t.e0 + t.ec; e++) {
				const u = f.edge_u[e], v = f.edge_v[e];
				if (!(f.node_comp[u] & bit) || !(f.node_comp[v] & bit)) continue;
				const pts = this.edgeCoords(e, false);
				let along = 0, bAlong = 0, bD = Infinity, bP = null;
				for (let k = 0; k + 1 < pts.length; k++) {
					const ax = (pts[k][0] - lon) * kx, ay = (pts[k][1] - lat) * ky;
					const vx = (pts[k + 1][0] - pts[k][0]) * kx, vy = (pts[k + 1][1] - pts[k][1]) * ky;
					const l2 = vx * vx + vy * vy, sl = Math.sqrt(l2);
					const q = l2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2)) : 0;
					const dx = ax + q * vx, dy = ay + q * vy, d = dx * dx + dy * dy;
					if (d < bD) { bD = d; bAlong = along + q * sl; bP = [pts[k][0] + q * (pts[k + 1][0] - pts[k][0]), pts[k][1] + q * (pts[k + 1][1] - pts[k][1])]; }
					along += sl;
				}
				const dist = Math.sqrt(bD);
				if (dist >= best.dist) continue;
				if (this.edgeCost(e, false, cp) === Infinity && this.edgeCost(e, true, cp) === Infinity) continue;
				const frac = along > 0 ? bAlong / along : 0;
				best = { e, frac, lon: bP[0], lat: bP[1], dist, node: frac < 0.5 ? u : v };
			}
		}
		return best;
	}

	async locate(lon, lat, profile) {
		await this.loadTiles(this.tilesAround(lon, lat, 1));
		const r = this.nearestEdge(lon, lat, profile);
		return r.e < 0 || r.dist > ROUTER_MAX_SNAP_M ? { node: -1, e: -1, dist: r.dist } : r;
	}

	// ------------------------------------------------------------------ A*
	// A* qui charge les tuiles au fil de la recherche : quand un nœud à développer (ou un de ses tronçons)
	// est dans une tuile absente, la recherche s'interrompt, la tuile est chargée, puis elle reprend
	// exactement où elle en était (tas, g, prédécesseurs conservés).
	// src / dst : résultat de locate() (point sur un tronçon) ou index de nœud.
	async route(src, dst, profile) {
		const t0 = performance.now();
		const cp = this.compileProfile(profile);
		const f = this.f, N = this.N;
		const S = typeof src === 'number' ? { node: src, e: -1 } : src;
		const D = typeof dst === 'number' ? { node: dst, e: -1 } : dst;
		const pt = P => (P.e >= 0 ? [P.lon, P.lat] : [this.lon[P.node], this.lat[P.node]]);
		const sPt = pt(S), dPt = pt(D);
		// préchargement en parallèle : couloir autour du segment départ -> arrivée, de demi-largeur
		// 6 km + 15 % de la distance (l'A* explore une ellipse d'autant plus large que le trajet est long)
		await this.loadTiles(this.corridor(sPt, dPt));
		await this.loadTiles([...this.tilesAround(sPt[0], sPt[1], 0), ...this.tilesAround(dPt[0], dPt[1], 0)]);
		// départs : les deux extrémités du tronçon de départ, avec le coût de la portion à parcourir
		// (pas = { e, rev, f0, f1 } : portion du tronçon de f0 à f1, fractions comptées depuis u)
		const seeds = [], tails = new Map();
		if (S.e < 0) seeds.push([S.node, 0, null]);
		else {
			const cu = this.edgeCost(S.e, true, cp), cv = this.edgeCost(S.e, false, cp);
			if (cu < Infinity) seeds.push([f.edge_u[S.e], cu * S.frac, { e: S.e, rev: true, f0: S.frac, f1: 0 }]);
			if (cv < Infinity) seeds.push([f.edge_v[S.e], cv * (1 - S.frac), { e: S.e, rev: false, f0: S.frac, f1: 1 }]);
		}
		// arrivées : coût restant depuis chaque extrémité du tronçon d'arrivée jusqu'au point
		if (D.e < 0) tails.set(D.node, [0, null]);
		else {
			const cu = this.edgeCost(D.e, true, cp), cv = this.edgeCost(D.e, false, cp);
			const add = (n, c, st) => { if (c < Infinity && !(tails.has(n) && tails.get(n)[0] <= c)) tails.set(n, [c, st]); };
			add(f.edge_u[D.e], cv * D.frac, { e: D.e, rev: false, f0: 0, f1: D.frac });
			add(f.edge_v[D.e], cu * (1 - D.frac), { e: D.e, rev: true, f0: 1, f1: D.frac });
		}
		let best = Infinity, bestEnd = -1, direct = null;
		if (S.e >= 0 && S.e === D.e) {        // départ et arrivée sur le même tronçon
			const rev = D.frac < S.frac, c = this.edgeCost(S.e, rev, cp) * Math.abs(D.frac - S.frac);
			if (c < Infinity) { best = c; direct = { e: S.e, rev, f0: S.frac, f1: D.frac }; }
		}
		const g = new Float64Array(N).fill(Infinity);
		const from = new Int32Array(N).fill(-1);     // entrée adj utilisée pour arriver (-1 : départ)
		const closed = new Uint8Array(N);
		const heap = new MinHeap();
		const dx0 = dPt[0], dy0 = dPt[1];
		const h = n => Math.hypot((this.lon[n] - dx0) * this.mPerDegLon, (this.lat[n] - dy0) * this.mPerDegLat) * cp.hPerM;
		const firstStep = new Map();
		for (const [n, c, st] of seeds) {
			if (c < g[n]) { g[n] = c; firstStep.set(n, st); heap.push(c + h(n), n); }
		}
		let explored = 0, pauses = 0;
		for (;;) {
			const need = new Set();
			while (heap.size) {
				const n = heap.pop();
				if (closed[n]) continue;
				if (g[n] + h(n) >= best) break;           // plus rien de meilleur à trouver (need vide : fin)
				if (!this.nodeLoaded[n]) { need.add(this.tileOfNode(n)); heap.push(g[n] + h(n), n); break; }
				for (let j = f.adj_off[n]; j < f.adj_off[n + 1]; j++) {
					const e = f.adj[j] & 0x7fffffff;
					if (!this.edgeLoaded[e]) need.add(this.tileOfEdge(e));
				}
				if (need.size) { heap.push(g[n] + h(n), n); break; }
				closed[n] = 1;
				explored++;
				const tl = tails.get(n);
				if (tl && g[n] + tl[0] < best) { best = g[n] + tl[0]; bestEnd = n; direct = null; }
				for (let j = f.adj_off[n]; j < f.adj_off[n + 1]; j++) {
					const a = f.adj[j];
					const e = a & 0x7fffffff, rev = a >>> 31 === 1;
					const m = rev ? f.edge_u[e] : f.edge_v[e];
					if (closed[m]) continue;
					const c = this.edgeCost(e, rev, cp);
					if (c === Infinity) continue;
					const ng = g[n] + c;
					if (ng < g[m]) {
						g[m] = ng;
						from[m] = j;
						heap.push(ng + h(m), m);
					}
				}
			}
			if (!need.size) break;
			pauses++;
			// la recherche déborde du couloir : tuiles manquantes + leurs voisines, pour limiter les pauses
			const more = [];
			for (const t of need) { const [i, j] = t.key.split('_').map(Number); for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const x = this.tileByKey.get(`${i + di}_${j + dj}`); if (x) more.push(x); } }
			await this.loadTiles(more);
		}
		if (best === Infinity) return null;

		// reconstruction
		let steps_;
		if (direct) steps_ = [direct];
		else {
			steps_ = [];
			const tl = tails.get(bestEnd)[1];
			if (tl) steps_.push(tl);
			let n = bestEnd;
			while (from[n] !== -1) {
				const a = f.adj[from[n]];
				const e = a & 0x7fffffff, rev = a >>> 31 === 1;
				steps_.push({ e, rev });
				n = rev ? f.edge_v[e] : f.edge_u[e];
			}
			const fs = firstStep.get(n);
			if (fs) steps_.push(fs);
			steps_.reverse();
		}
		const last = steps_.length ? steps_[steps_.length - 1] : null;
		if (last) await this.loadTile(this.tileOfNode(last.rev ? f.edge_u[last.e] : f.edge_v[last.e]));   // manœuvres
		const res = this._describe(S, steps_, best, explored, performance.now() - t0);
		res.src = S; res.dst = D;
		res.pauses = pauses;
		return res;
	}

	// Itinéraire par des points de passage : pts = [départ, passages…, arrivée] (résultats de locate()).
	// Un calcul par tronçon (A* ou « le plus plat » si flatDetour est un nombre), puis tous les pas mis bout à
	// bout et décrits d'un seul tenant : distance, D+, profil, couleurs de pente et manœuvres comme un trajet
	// simple. route.vias = points de passage, route.legEnds[k] = indice dans coords de la fin du tronçon k (le
	// guidage s'en sert pour ne viser que les points pas encore atteints).
	// Renvoie la route, ou en mode plat { route, ref, lambda, runs, ms } comme flattest().
	async routeVia(pts, profile, flatDetour = null) {
		const t0 = performance.now();
		const legs = [], refs = [];
		let runs = 0, lambda = null;
		for (let i = 0; i + 1 < pts.length; i++) {
			if (flatDetour !== null) {
				const fl = await this.flattest(pts[i], pts[i + 1], profile, flatDetour);
				if (!fl) return null;
				legs.push(fl.route); refs.push(fl.ref); runs += fl.runs; lambda = fl.lambda;
			} else {
				const r = await this.route(pts[i], pts[i + 1], profile);
				if (!r) return null;
				legs.push(r);
			}
		}
		const joindre = rs => {
			const res = rs.length === 1 ? rs[0] : this._describe(rs[0].src, rs.flatMap(r => r.steps),
				rs.reduce((a, r) => a + r.cost, 0), rs.reduce((a, r) => a + r.explored, 0), performance.now() - t0);
			res.src = rs[0].src; res.dst = rs[rs.length - 1].dst;
			res.vias = pts.slice(1, -1);
			// chaque tronçon partage son premier point avec la fin du précédent
			let fin = -1;
			res.legEnds = rs.map(r => (fin += r.coords.length - (fin < 0 ? 0 : 1)));
			return res;
		};
		const route = joindre(legs);
		if (flatDetour === null) return route;
		return { route, ref: joindre(refs), lambda, runs, ms: performance.now() - t0 };
	}

	// Mode « le plus plat » : minimise le D+ sous contrainte de détour.
	// maxDetour = 0.3 => au plus 30 % plus long que l'itinéraire de référence ; Infinity = illimité.
	// Relaxation lagrangienne : on augmente le poids du dénivelé (λ = profile.hills) tant que la
	// distance reste dans le budget, par dichotomie sur log(λ). Parmi les itinéraires faisables, on
	// garde le plus court de ceux dont le D+ est à moins de ROUTER_FLAT_TIE_* du D+ minimal.
	async flattest(src, dst, profile, maxDetour) {
		const t0 = performance.now();
		const ref = await this.route(src, dst, { ...profile, hills: 1 });
		if (!ref) return null;
		const budget = ref.distance * (1 + maxDetour) + 1;
		const ok = [{ r: ref, l: 1 }];
		let runs = 1;
		const consider = (r, l) => {
			runs++;
			const feasible = !!r && r.distance <= budget;
			if (feasible) ok.push({ r, l });
			return feasible;
		};
		const LMAX = 300;
		if (!consider(await this.route(src, dst, { ...profile, hills: LMAX }), LMAX)) {
			let lo = 0, hi = Math.log(LMAX);          // log λ ; λ=1 toujours faisable
			for (let i = 0; i < 9; i++) {
				const mid = (lo + hi) / 2, l = Math.exp(mid);
				if (consider(await this.route(src, dst, { ...profile, hills: l }), l)) lo = mid; else hi = mid;
			}
		}
		// λ intermédiaires : variantes presque aussi plates mais plus courtes (sinon, quand λ max tient
		// dans le budget, seuls λ=1 et λ max seraient comparés)
		for (const l of [3, 10, 30, 100]) consider(await this.route(src, dst, { ...profile, hills: l }), l);
		const dmin = Math.min(...ok.map(c => c.r.dplus));
		const tie = Math.max(ROUTER_FLAT_TIE_MIN, dmin * ROUTER_FLAT_TIE_REL);
		const best = ok.filter(c => c.r.dplus <= dmin + tie)
			.reduce((a, c) => (c.r.distance < a.r.distance ? c : a));
		return { route: best.r, ref, lambda: best.l, runs, ms: performance.now() - t0 };
	}

	// Points du tronçon e dans le sens de parcours
	edgeCoords(e, rev) {
		const f = this.f;
		const pts = [[this.lon[f.edge_u[e]], this.lat[f.edge_u[e]]]];
		for (let k = f.geom_off[e]; k < f.geom_off[e + 1]; k++) {
			pts.push([f.geom_lon[k] * 1e-6, f.geom_lat[k] * 1e-6]);
		}
		pts.push([this.lon[f.edge_v[e]], this.lat[f.edge_v[e]]]);
		if (rev) pts.reverse();
		return pts;
	}

	// Profil du tronçon e : [[fraction de longueur depuis u, altitude m], …], nœuds u et v compris
	edgeElev(e) {
		const f = this.f, out = [[0, f.node_z[f.edge_u[e]] * 0.1]];
		for (let k = f.prof_off[e]; k < f.prof_off[e + 1]; k++) out.push([f.prof_pos[k] / 65535, f.prof_z[k] * 0.1]);
		out.push([1, f.node_z[f.edge_v[e]] * 0.1]);
		return out;
	}

	// Altitude au point de fraction fr du tronçon e (interpolée sur son profil)
	elevAt(e, fr) {
		const P = this.edgeElev(e);
		let k = 1;
		while (k < P.length - 1 && P[k][0] < fr) k++;
		const [f0, z0] = P[k - 1], [f1, z1] = P[k];
		return f1 > f0 ? z0 + (z1 - z0) * (fr - f0) / (f1 - f0) : z0;
	}

	// Points de la portion [f0, f1] du tronçon e (fractions de longueur depuis u), dans le sens f0 -> f1
	sliceEdge(e, f0, f1) {
		if (f0 > f1) return this.sliceEdge(e, f1, f0).reverse();
		const pts = this.edgeCoords(e, false), kx = this.mPerDegLon, ky = this.mPerDegLat;
		const cum = [0];
		for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot((pts[k][0] - pts[k - 1][0]) * kx, (pts[k][1] - pts[k - 1][1]) * ky));
		const L = cum[cum.length - 1], a = f0 * L, b = f1 * L;
		const at = x => {
			let k = 1;
			while (k < pts.length - 1 && cum[k] < x) k++;
			const q = cum[k] > cum[k - 1] ? (x - cum[k - 1]) / (cum[k] - cum[k - 1]) : 0;
			return [pts[k - 1][0] + q * (pts[k][0] - pts[k - 1][0]), pts[k - 1][1] + q * (pts[k][1] - pts[k - 1][1])];
		};
		const out = [at(a)];
		for (let k = 1; k < pts.length - 1; k++) if (cum[k] > a && cum[k] < b) out.push(pts[k]);
		out.push(at(b));
		return out;
	}

	// start : point de départ (locate) ou { node }. Les pas partiels (f0/f1) comptent au prorata de la
	// portion parcourue ; altitude du point interpolée entre les extrémités.
	_describe(start, steps, cost, explored, ms) {
		const f = this.f;
		const zAt = (e, fr) => this.elevAt(e, fr);
		let coords, z0, n0;
		if (steps.length && steps[0].f0 !== undefined) {
			const s0 = steps[0];
			coords = [this.sliceEdge(s0.e, s0.f0, s0.f1)[0]]; z0 = zAt(s0.e, s0.f0);
			n0 = s0.f0 === 0 ? f.edge_u[s0.e] : s0.f0 === 1 ? f.edge_v[s0.e] : -1;
		} else if (start.e >= 0) {               // aucun pas : départ = arrivée, en milieu de tronçon
			n0 = -1; coords = [[start.lon, start.lat]]; z0 = zAt(start.e, start.frac);
		} else {
			n0 = start.node; coords = [[this.lon[n0], this.lat[n0]]]; z0 = f.node_z[n0] * 0.1;
		}
		const segments = [];   // morceaux de pente régulière (profil simplifié des tronçons) : coordonnées + pente, pour colorer
		const profile = [[0, z0]];   // par pas : [distance cumulée m, altitude m] (manœuvres)
		const elev = [[0, z0, '']];  // profil fin : [distance cumulée m, altitude m, classe du morceau qui y mène]
		const nodes = [n0], nodeIdx = [0];             // nœuds traversés (-1 : point en milieu de tronçon)
		let dist = 0, dplus = 0, dminus = 0, time = 0;
		for (const st of steps) {
			const { e, rev } = st;
			const part = st.f0 !== undefined;
			const w = part ? Math.abs(st.f1 - st.f0) : 1;
			const pts = part ? this.sliceEdge(e, st.f0, st.f1) : this.edgeCoords(e, rev);
			const len = f.edge_len[e] * 0.1 * w;
			const dp = (rev ? f.edge_dm[e] : f.edge_dp[e]) * 0.1 * w;
			const dm = (rev ? f.edge_dp[e] : f.edge_dm[e]) * 0.1 * w;
			dist += len; dplus += dp; dminus += dm;
			time += this.edgeTime(e, rev) * w;
			const fEnd = part ? st.f1 : (rev ? 0 : 1);
			const end = fEnd === 0 ? f.edge_u[e] : fEnd === 1 ? f.edge_v[e] : -1;
			profile.push([dist, end >= 0 ? f.node_z[end] * 0.1 : zAt(e, fEnd)]);
			// morceaux entre les points du profil du tronçon compris dans la portion parcourue
			const cls = this.meta.classes[f.edge_cls[e]], L = f.edge_len[e] * 0.1;
			const fStart = part ? st.f0 : (rev ? 1 : 0);
			const lo = Math.min(fStart, fEnd), hi = Math.max(fStart, fEnd);
			const cut = this.edgeElev(e).filter(([fr]) => fr > lo && fr < hi);
			if (fStart > fEnd) cut.reverse();
			const marks = [[fStart, zAt(e, fStart)], ...cut, [fEnd, zAt(e, fEnd)]];
			let d = dist - len;
			for (let k = 1; k < marks.length; k++) {
				const [fa, za] = marks[k - 1], [fb, zb] = marks[k];
				const dd = Math.abs(fb - fa) * L;
				d += dd;
				segments.push({
					coords: marks.length === 2 ? pts : this.sliceEdge(e, fa, fb),
					grade: dd > 0 ? (zb - za) / dd * 100 : 0,
					cls,
				});
				elev.push([d, zb, cls]);
			}
			for (let k = 1; k < pts.length; k++) coords.push(pts[k]);
			nodes.push(end); nodeIdx.push(coords.length - 1);
		}
		return { coords, segments, profile, elev, steps, nodes, nodeIdx,
			distance: dist, dplus, dminus, time, cost, explored, ms };
	}

	// ------------------------------------------------------------------ instructions de virage
	_bearing(a, b) {   // cap (degrés, 0 = nord, sens horaire) de a vers b, [lon, lat]
		const dx = (b[0] - a[0]) * this.mPerDegLon, dy = (b[1] - a[1]) * this.mPerDegLat;
		return Math.atan2(dx, dy) * 180 / Math.PI;
	}

	// Cap en partant de pts[i] dans la direction dir (+1/-1), mesuré sur ~dmin mètres
	_bearingAlong(pts, i, dir, dmin = 20) {
		const p0 = pts[i];
		let j = i, d = 0;
		while (j + dir >= 0 && j + dir < pts.length && d < dmin) {
			const a = pts[j], b = pts[j + dir];
			d += Math.hypot((b[0] - a[0]) * this.mPerDegLon, (b[1] - a[1]) * this.mPerDegLat);
			j += dir;
		}
		return j === i ? null : this._bearing(p0, pts[j]);
	}

	static _angleDiff(a, b) {   // b - a ramené dans ]-180, 180] ; > 0 = vers la droite
		let d = (b - a) % 360;
		if (d > 180) d -= 360;
		if (d <= -180) d += 360;
		return d;
	}

	// Liste des manœuvres d'un itinéraire : [{k, coordIdx, dist, type, angle, exit, side, text}]
	// type : 'turn' (angle signé, side 'left'/'right'), 'roundabout' (exit = n° de sortie), 'arrive'
	maneuvers(res, profile) {
		const cp = this.compileProfile(profile);
		const f = this.f, RB = this.F.roundabout;
		const { coords, steps, nodes, nodeIdx } = res;
		const out = [];
		const isRb = e => (f.edge_flg[e] & RB) !== 0;
		// tronçons praticables partant du nœud n, sauf ceux de l'itinéraire
		const branches = (n, exclude) => {
			const list = [];
			for (let j = f.adj_off[n]; j < f.adj_off[n + 1]; j++) {
				const a = f.adj[j], e = a & 0x7fffffff, rev = a >>> 31 === 1;
				if (exclude.includes(e) || this.edgeCost(e, rev, cp) === Infinity) continue;
				list.push({ e, rev });
			}
			return list;
		};
		for (let k = 1; k < nodes.length - 1; k++) {
			const n = nodes[k], i = nodeIdx[k];
			const eIn = steps[k - 1].e, eOut = steps[k].e;
			const bIn = this._bearingAlong(coords, i, -1);
			const bOut = this._bearingAlong(coords, i, +1);
			if (bIn === null || bOut === null) continue;
			const headingIn = (bIn + 180) % 360;
			const angle = BikeRouter._angleDiff(headingIn, bOut);
			// point de passage au milieu d'un tronçon (pas de carrefour) : seulement un éventuel demi-tour
			if (n < 0) {
				if (Math.abs(angle) > 150) out.push({ k, coordIdx: i, dist: res.profile[k][0], type: 'turn', angle, side: angle < 0 ? 'left' : 'right' });
				continue;
			}

			// entrée dans un rond-point : on compte les sorties jusqu'à celle qu'on prend
			if (!isRb(eIn) && isRb(eOut)) {
				let m = k + 1, exit = 0;
				for (; m < nodes.length - 1; m++) {
					const others = branches(nodes[m], [steps[m - 1].e, steps[m].e]).filter(b => !isRb(b.e));
					const leaving = !isRb(steps[m].e);
					if (others.length || leaving) exit++;
					if (leaving) break;
				}
				// angle global entrée -> sortie, pour dessiner la flèche
				const bExit = this._bearingAlong(coords, nodeIdx[Math.min(m, nodes.length - 1)], +1);
				const a = bExit === null ? 0 : BikeRouter._angleDiff(headingIn, bExit);
				out.push({ k, coordIdx: i, dist: res.profile[k][0], type: 'roundabout', exit: Math.max(1, exit),
					angle: a, side: a < -20 ? 'left' : a > 20 ? 'right' : 'straight' });
				k = m;   // pas d'autre manœuvre dans le rond-point
				continue;
			}
			if (isRb(eIn) && isRb(eOut)) continue;

			// branches « cyclables » concurrentes (on ignore trottoirs / escaliers sauf si on y circule)
			const onFoot = (f.edge_flg[eOut] & this.F.dismount) || f.edge_cls[eOut] === cp.steps;
			const others = branches(n, [eIn, eOut]).filter(b =>
				onFoot || !((f.edge_flg[b.e] & this.F.dismount) || f.edge_cls[b.e] === cp.steps));
			if (!others.length) continue;      // simple courbe, pas de choix possible
			const abs = Math.abs(angle);
			let minOther = Infinity, closest = Infinity;
			for (const b of others) {
				const bb = this._bearingAlong(this.edgeCoords(b.e, b.rev), 0, +1);
				if (bb === null) continue;
				const ao = BikeRouter._angleDiff(headingIn, bb);
				minOther = Math.min(minOther, Math.abs(ao));
				closest = Math.min(closest, Math.abs(ao - angle));
			}
			const notStraightest = minOther < abs - 5;      // une autre branche va plus « tout droit »
			const ambiguous = abs >= 10 && closest < 25;      // fourche serrée
			if (abs >= 60 || notStraightest || ambiguous) {
				out.push({ k, coordIdx: i, dist: res.profile[k][0], type: 'turn', angle, side: angle < 0 ? 'left' : 'right' });
			}
		}

		// regroupe les manœuvres distantes de moins de MERGE m (carrefours en plusieurs nœuds)
		const MERGE = 25;
		const merged = [];
		for (let a = 0; a < out.length;) {
			let b = a;
			while (b + 1 < out.length && out[b + 1].type === 'turn' && out[b].type === 'turn'
				&& out[b + 1].dist - out[b].dist < MERGE) b++;
			if (b === a) { merged.push(out[a]); a++; continue; }
			const first = out[a], last = out[b];
			const bIn = this._bearingAlong(coords, first.coordIdx, -1);
			const bOut = this._bearingAlong(coords, last.coordIdx, +1);
			const net = (bIn === null || bOut === null) ? first.angle : BikeRouter._angleDiff((bIn + 180) % 360, bOut);
			if (Math.abs(net) >= 30) {
				merged.push({ ...first, angle: net, side: net < 0 ? 'left' : 'right' });
			} else {
				// baïonnette (gauche puis droite) : on garde les vrais virages, on jette les zigzags
				for (let c = a; c <= b; c++) if (Math.abs(out[c].angle) >= 60) merged.push(out[c]);
			}
			a = b + 1;
		}
		out.length = 0;
		out.push(...merged);
		out.push({ k: nodes.length - 1, coordIdx: coords.length - 1, dist: res.distance, type: 'arrive', angle: 0, side: 'straight' });
		for (const m of out) m.text = BikeRouter.maneuverText(m);
		return out;
	}

	static maneuverText(m) {
		if (m.type === 'arrive') return 'Arrivée';
		if (m.type === 'roundabout') return `Rond-point, ${m.exit === 1 ? '1re' : m.exit + 'e'} sortie`;
		const a = Math.abs(m.angle), cote = m.angle < 0 ? 'à gauche' : 'à droite';
		if (a >= 170) return 'Demi-tour';
		if (a >= 130) return `Franchement ${cote}`;
		if (a >= 60) return `Tournez ${cote}`;
		return `Légèrement ${cote}`;
	}
}
