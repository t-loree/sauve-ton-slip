// Prévision immédiate de la pluie, calculée dans le navigateur à partir du radar RainViewer (sans serveur).
// Version de production de la POC poc/radar/ (nowcast.js + methods.js), réduite à deux méthodes :
//  - extrapolation : déplacement mesuré entre les images à −20 min et 0 (block matching global puis par
//    blocs de ~75 km), puis advection semi-lagrangienne de la dernière image ;
//  - probabilité (voisinage) : part des pixels pluvieux de l'extrapolation dans un rayon qui grandit avec
//    l'échéance.
// Tuiles non lissées ('0_0') : 69 couleurs = pas de 1 dBZ de −5 à 63, décodées en dBZ et réaffichées avec la
// même palette. Bloc de 3×3 tuiles au zoom 7 (~630 km) autour du point, chargé par le navigateur.
// Pluie.prevoir(lon, lat) -> { etendue (EPSG:3857), etapes: [{ min, t, img, proba?, mm, p? }], probaIci, vitesse,
// cap, pluieMaintenant, sec } ; img / proba : images PNG (data:) du bloc ; mm : pluie au point (mm/h) ; p : risque.
// Caches (Cache Storage « sts-radar », hors du cache HTTP du navigateur) : tuiles 60 min au plus, prévision
// calculée 5 min (même image radar, même point) ; la liste des images radar 5 min (localStorage).

const Pluie = (() => {
	const Z = 7, T = 256, NT = 3, N = NT * T, WORLD = T * 2 ** Z, HALF = Math.PI * 6378137;
	const FLOOR = -10, DBZ0 = -5, SEUIL = 20;   // ≥ 20 dBZ ≈ 0,6 mm/h : il pleut vraiment
	const API = 'https://api.rainviewer.com/public/weather-maps.json';

	// ---------- géométrie Web Mercator (pixels globaux au zoom 7) ----------
	const lonToX = lon => (lon + 180) / 360 * WORLD;
	const latToY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * WORLD;
	const xToLon = x => x / WORLD * 360 - 180;
	const yToLat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / WORLD))) * 180 / Math.PI;
	function km(lon1, lat1, lon2, lat2) {
		const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2
			+ Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
		return 12742 * Math.asin(Math.sqrt(a));
	}

	// ---------- palette RainViewer : PAL[k] = dBZ −5 + k ----------
	const beige = [[99, 97, 89, 20], [102, 99, 90, 25], [105, 102, 92, 30], [108, 104, 93, 36], [111, 107, 95, 41],
		[114, 110, 97, 46], [117, 112, 98, 52], [120, 115, 100, 57], [124, 117, 101, 62], [127, 120, 103, 68],
		[130, 123, 105, 73], [133, 125, 106, 78], [136, 128, 108, 84], [139, 130, 109, 89], [142, 133, 111, 94],
		[146, 136, 113, 100], [158, 147, 117, 110], [170, 158, 121, 120], [182, 169, 126, 130], [194, 180, 130, 140],
		[206, 192, 135, 150], [210, 196, 139, 160], [214, 200, 143, 170], [218, 204, 147, 180], [222, 208, 151, 190]];
	const opaque = [[136, 221, 238], [108, 209, 235], [81, 197, 232], [54, 186, 229], [27, 174, 226], [0, 163, 224],
		[0, 154, 213], [0, 145, 202], [0, 136, 191], [0, 127, 180], [0, 119, 170], [0, 112, 163], [0, 105, 156],
		[0, 98, 149], [0, 91, 142], [0, 85, 136], [0, 81, 128], [0, 78, 120], [0, 74, 112], [0, 71, 104],
		...[238, 224, 210, 197, 183, 170, 159, 149, 139, 129].map(g => [255, g, 0]),
		[255, 68, 0], [242, 54, 0], [230, 40, 0], [217, 27, 0], [205, 13, 0], [193, 0, 0], [168, 0, 0],
		[143, 0, 0], [118, 0, 0], [93, 0, 0], ...[170, 159, 149, 139].map(g => [255, g, 255])];
	const PAL = [...beige, ...opaque.map(c => [...c, 255])];
	const connues = new Map(PAL.map((c, k) => [c.join(','), DBZ0 + k]));
	function proche(r, g, b, a) {
		let best = 0, bd = Infinity;
		PAL.forEach((c, k) => { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 + (c[3] - a) ** 2; if (d < bd) { bd = d; best = k; } });
		return DBZ0 + best;
	}
	function decoder(rgba) {
		const o = new Float32Array(N * N).fill(FLOOR);
		for (let q = 0, p = 0; q < o.length; q++, p += 4) {
			if (!rgba[p + 3]) continue;
			const k = `${rgba[p]},${rgba[p + 1]},${rgba[p + 2]},${rgba[p + 3]}`;
			let v = connues.get(k);
			if (v === undefined) { v = proche(rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]); connues.set(k, v); }
			o[q] = v;
		}
		return o;
	}
	function rendre(dbz) {
		const o = new Uint8ClampedArray(N * N * 4);
		for (let q = 0, p = 0; q < dbz.length; q++, p += 4) {
			const k = Math.round(dbz[q]) - DBZ0;
			if (k < 0) continue;
			const c = PAL[Math.min(k, PAL.length - 1)];
			o[p] = c[0]; o[p + 1] = c[1]; o[p + 2] = c[2]; o[p + 3] = c[3];
		}
		return o;
	}
	function rendreProba(P) {   // rien sous 10 %, puis violet de plus en plus soutenu
		const o = new Uint8ClampedArray(N * N * 4);
		for (let q = 0, p = 0; q < P.length; q++, p += 4) {
			const v = P[q];
			if (v < 0.1) continue;
			o[p] = 200 - 140 * v; o[p + 1] = 120 - 110 * v; o[p + 2] = 230 - 60 * v; o[p + 3] = 70 + 185 * v;
		}
		return o;
	}

	// ---------- tuiles ----------
	// RainViewer envoie ses tuiles avec un cache HTTP de 48 h : on le contourne (cache: 'no-store') et on les
	// garde nous-mêmes 60 min au plus (Cache Storage), ce qui suffit puisque seules les 20 dernières minutes servent
	const CACHE_RADAR = 'sts-radar', TTL_TUILE = 60 * 60 * 1000, TTL_PREV = 5 * 60 * 1000;
	const ouvrirCache = () => ('caches' in self ? caches.open(CACHE_RADAR).catch(() => null) : Promise.resolve(null));
	const age = r => Date.now() - (+r.headers.get('x-sts-t') || 0);
	const reponse = (corps, type) => new Response(corps, { headers: { 'x-sts-t': String(Date.now()), 'content-type': type } });
	async function purger(cache) {   // tout ce qui a plus d'une heure
		if (!cache) return;
		for (const req of await cache.keys()) {
			const r = await cache.match(req);
			if (!r || age(r) > TTL_TUILE) await cache.delete(req);
		}
	}
	async function tuile(cache, url) {
		try {
			let r = cache && await cache.match(url);
			if (r && age(r) > TTL_TUILE) r = null;
			let blob;
			if (r) blob = await r.blob();
			else {
				const rep = await fetch(url, { cache: 'no-store' });
				if (!rep.ok) return null;
				blob = await rep.blob();
				if (cache) await cache.put(url, reponse(blob, blob.type || 'image/png'));
			}
			return await createImageBitmap(blob);
		} catch (e) { return null; }   // tuile absente = pas de pluie
	}
	async function bloc(cache, host, path, tx0, ty0) {
		const c = document.createElement('canvas');
		c.width = c.height = N;
		const g = c.getContext('2d', { willReadFrequently: true });
		const ims = await Promise.all(Array.from({ length: NT * NT }, (_, k) =>
			tuile(cache, `${host}${path}/256/${Z}/${tx0 + k % NT}/${ty0 + Math.floor(k / NT)}/2/0_0.png`)));
		ims.forEach((im, k) => { if (im) { g.drawImage(im, (k % NT) * T, Math.floor(k / NT) * T); im.close(); } });
		return decoder(g.getImageData(0, 0, N, N).data);
	}

	// ---------- mesure du déplacement (block matching) ----------
	function reduire(a, n) {
		const m = n / 2, o = new Float32Array(m * m);
		for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
			const i = 2 * y * n + 2 * x;
			o[y * m + x] = (a[i] + a[i + 1] + a[i + n] + a[i + n + 1]) / 4;
		}
		return o;
	}
	function cout(A, B, n, x0, y0, x1, y1, dx, dy) {
		let s = 0;
		for (let y = y0; y < y1; y++) {
			const ra = y * n, rb = (y + dy) * n + dx;
			for (let x = x0; x < x1; x++) { const e = A[ra + x] - B[rb + x]; s += e * e; }
		}
		return s / ((x1 - x0) * (y1 - y0));
	}
	function chercher(A, B, n, x0, y0, x1, y1, cx, cy, r) {
		let best = Infinity, bx = cx, by = cy;
		const C = new Map();
		for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
			if (x0 + dx < 0 || y0 + dy < 0 || x1 + dx > n || y1 + dy > n) continue;
			const c = cout(A, B, n, x0, y0, x1, y1, dx, dy);
			C.set(dx + ',' + dy, c);
			if (c < best) { best = c; bx = dx; by = dy; }
		}
		const sub = (m, z, p) => (m == null || p == null) ? 0 : Math.max(-.5, Math.min(.5, (m - p) / (2 * (m - 2 * z + p) || 1)));
		const at = (dx, dy) => C.get(dx + ',' + dy);
		return { dx: bx + sub(at(bx - 1, by), best, at(bx + 1, by)), dy: by + sub(at(bx, by - 1), best, at(bx, by + 1)),
			bord: Math.abs(bx - cx) === r || Math.abs(by - cy) === r };
	}
	// intensité pour la mesure : 0 sans pluie, croissante avec les dBZ
	const intensite = d => { const o = new Float32Array(d.length); for (let i = 0; i < d.length; i++) o[i] = d[i] > DBZ0 ? (d[i] - DBZ0) / 40 : 0; return o; };
	function mesurer(dA, dB) {
		const n2 = N / 2, n4 = N / 4;
		const a2 = reduire(intensite(dA), N), b2 = reduire(intensite(dB), N), a4 = reduire(a2, n2), b4 = reduire(b2, n2);
		if (a2.reduce((s, v) => s + (v > 0.05), 0) / a2.length < 0.003) return null;   // trop peu de pluie
		const r4 = 12, m2 = 2 * r4 + 8;
		const g4 = chercher(a4, b4, n4, r4, r4, n4 - r4, n4 - r4, 0, 0, r4);
		const g = chercher(a2, b2, n2, m2, m2, n2 - m2, n2 - m2, Math.round(g4.dx * 2), Math.round(g4.dy * 2), 2);
		const vec = [], BS = 48, R = 4;
		for (let by = m2; by + BS <= n2 - m2; by += BS / 2) for (let bx = m2; bx + BS <= n2 - m2; bx += BS / 2) {
			let mouille = 0;
			for (let y = by; y < by + BS; y++) for (let x = bx; x < bx + BS; x++) mouille += a2[y * n2 + x] > 0.05;
			if (mouille / (BS * BS) < 0.08) continue;
			const l = chercher(a2, b2, n2, bx, by, bx + BS, by + BS, Math.round(g.dx), Math.round(g.dy), R);
			if (!l.bord) vec.push({ x: bx + BS / 2, y: by + BS / 2, dx: l.dx, dy: l.dy });
		}
		return { g, vec };   // pixels réduits ×2
	}

	// vitesse par pixel (pixels pleine résolution / min) : vecteurs locaux lissés (~110 km) mêlés au global
	function vitesses(m, minutes) {
		const gv = [m.g.dx * 2 / minutes, m.g.dy * 2 / minutes];
		const loc = m.vec.map(v => ({ x: v.x * 2, y: v.y * 2, u: v.dx * 2 / minutes, v: v.dy * 2 / minutes }));
		const S = 8, M = N / S + 1, Ug = new Float32Array(M * M), Vg = new Float32Array(M * M), sig2 = 2 * 96 ** 2, W0 = 0.3;
		for (let j = 0; j < M; j++) for (let k = 0; k < M; k++) {
			let w = W0, su = W0 * gv[0], sv = W0 * gv[1];
			for (const l of loc) { const e = Math.exp(-((k * S - l.x) ** 2 + (j * S - l.y) ** 2) / sig2); w += e; su += e * l.u; sv += e * l.v; }
			Ug[j * M + k] = su / w; Vg[j * M + k] = sv / w;
		}
		const U = new Float32Array(N * N), V = new Float32Array(N * N);
		for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
			const fx = x / S, fy = y / S, k = Math.min(Math.floor(fx), M - 2), j = Math.min(Math.floor(fy), M - 2);
			const tx = fx - k, ty = fy - j, p = j * M + k, b = (A) => (A[p] * (1 - tx) + A[p + 1] * tx) * (1 - ty) + (A[p + M] * (1 - tx) + A[p + M + 1] * tx) * ty;
			U[y * N + x] = b(Ug); V[y * N + x] = b(Vg);
		}
		return { U, V };
	}
	function advecter(X, { U, V }, t) {   // o(x) = X(x − v(x)·t), bilinéaire
		const o = new Float32Array(N * N);
		for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
			const sx = x - U[i] * t, sy = y - V[i] * t, x0 = Math.floor(sx), y0 = Math.floor(sy);
			if (x0 < 0 || y0 < 0 || x0 >= N - 1 || y0 >= N - 1) { o[i] = FLOOR; continue; }
			const fx = sx - x0, fy = sy - y0, p = y0 * N + x0;
			o[i] = (X[p] * (1 - fx) + X[p + 1] * fx) * (1 - fy) + (X[p + N] * (1 - fx) + X[p + N + 1] * fx) * fy;
		}
		return o;
	}
	function flou(X, r, passes) {   // moyenne glissante carrée, `passes` fois (3 ≈ gaussienne)
		const a = Float32Array.from(X), b = new Float32Array(N * N), w = 2 * r + 1, c = v => Math.min(N - 1, Math.max(0, v));
		for (let k = 0; k < passes; k++) {
			for (let y = 0; y < N; y++) {
				const row = y * N; let s = 0;
				for (let x = -r; x <= r; x++) s += a[row + c(x)];
				for (let x = 0; x < N; x++) { b[row + x] = s / w; s += a[row + c(x + r + 1)] - a[row + c(x - r)]; }
			}
			for (let x = 0; x < N; x++) {
				let s = 0;
				for (let y = -r; y <= r; y++) s += b[c(y) * N + x];
				for (let y = 0; y < N; y++) { a[y * N + x] = s / w; s += b[c(y + r + 1) * N + x] - b[c(y - r) * N + x]; }
			}
		}
		return a;
	}
	function proba(E, L) {
		const b = new Float32Array(N * N);
		for (let i = 0; i < b.length; i++) b[i] = E[i] >= SEUIL ? 1 : 0;
		return flou(b, Math.round(2 + 0.2 * L), 3);
	}

	// image du bloc -> PNG (data:), à poser en EPSG:3857 sur `etendue` ; texte : se garde tel quel en cache
	function image(rgba) {
		const c = document.createElement('canvas');
		c.width = c.height = N;
		c.getContext('2d').putImageData(new ImageData(rgba, N, N), 0, 0);
		return c.toDataURL();
	}
	const etendue = (tx0, ty0) => {
		const mx = px => px / WORLD * 2 * HALF - HALF, my = py => HALF - py / WORLD * 2 * HALF;
		return [mx(tx0 * T), my((ty0 + NT) * T), mx((tx0 + NT) * T), my(ty0 * T)];
	};
	const taux = d => d < 7 ? 0 : (10 ** (d / 10) / 200) ** (1 / 1.6);   // dBZ -> mm/h (Marshall-Palmer), < 0,1 mm/h = sec

	const pause = () => new Promise(r => setTimeout(r));   // rend la main entre deux calculs lourds

	// liste des images radar gardée 5 min (RainViewer en publie une toutes les 10 min) : rouvrir la fenêtre en
	// changeant de page ne refait pas la requête ; les tuiles, elles, restent 48 h dans le cache du navigateur
	const CLE_LISTE = 'sts-radar-liste', TTL_LISTE = 5 * 60 * 1000;
	async function liste() {
		try {
			const m = JSON.parse(localStorage.getItem(CLE_LISTE));
			if (m && Date.now() - m.t < TTL_LISTE) return m.j;
		} catch (e) { /* stockage indisponible */ }
		const j = await (await fetch(API)).json();
		try { localStorage.setItem(CLE_LISTE, JSON.stringify({ t: Date.now(), j: { host: j.host, radar: { past: j.radar.past } } })); } catch (e) { /* idem */ }
		return j;
	}

	async function prevoir(lon, lat) {
		const cache = await ouvrirCache();
		const j = await liste();
		const past = j.radar.past, B = past[past.length - 1];
		// prévision déjà calculée il y a moins de 5 min pour la même image et le même point : rien à refaire
		const cle = `https://sts.invalid/prevision/${lon},${lat}${B.path}`;
		const deja = cache && await cache.match(cle);
		if (deja && age(deja) < TTL_PREV) return deja.json();
		await purger(cache);
		const avant = min => past.reduce((m, f) => Math.abs(B.time - f.time - min * 60) < Math.abs(B.time - m.time - min * 60) ? f : m, past[0]);
		const A = avant(20), M = avant(10);
		const tx0 = Math.floor(lonToX(lon) / T) - 1, ty0 = Math.floor(latToY(lat) / T) - 1;
		const [dA, dM, dB] = await Promise.all([A, M, B].map(f => bloc(cache, j.host, f.path, tx0, ty0)));
		await pause();
		const minutes = (B.time - A.time) / 60 || 20;
		const m = mesurer(dA, dB);
		const vit = m ? vitesses(m, minutes) : null;
		// pixel du point demandé dans le bloc
		const px = Math.round(lonToX(lon) - tx0 * T), py = Math.round(latToY(lat) - ty0 * T);
		const ici = P => (px >= 0 && py >= 0 && px < N && py < N) ? P[py * N + px] : null;
		const mmIci = d => {   // pluie moyenne sur 3 × 3 pixels (~2,5 km) autour du point, en mm/h
			if (px < 1 || py < 1 || px >= N - 1 || py >= N - 1) return null;
			let s = 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += taux(d[(py + dy) * N + px + dx]);
			return s / 9;
		};
		const passe = (f, d) => ({ min: -Math.round((B.time - f.time) / 60), t: f.time, img: image(rendre(d)), mm: mmIci(d) });
		const etapes = [passe(A, dA), passe(M, dM), passe(B, dB)];
		const probaIci = {};
		for (const L of [10, 20, 30]) {
			await pause();
			const E = vit ? advecter(dB, vit, L) : dB;
			const P = proba(E, L);
			probaIci[L] = ici(P);
			etapes.push({ min: L, t: B.time + L * 60, img: image(rendre(E)), proba: image(rendreProba(P)), mm: mmIci(E), p: probaIci[L] });
		}
		// vitesse et cap du déplacement global, au centre du bloc
		let vitesse = null, cap = null;
		if (m) {
			const c = N / 2, X = p => tx0 * T + p, Y = p => ty0 * T + p;
			vitesse = km(xToLon(X(c)), yToLat(Y(c)), xToLon(X(c + m.g.dx * 2)), yToLat(Y(c + m.g.dy * 2))) / minutes * 60;
			cap = (Math.atan2(m.g.dx, -m.g.dy) * 180 / Math.PI + 360) % 360;
		}
		const pluieIci = ici(dB);
		const res = { etendue: etendue(tx0, ty0), etapes, probaIci, pluieMaintenant: pluieIci != null && pluieIci >= SEUIL, vitesse, cap, sec: !m };
		if (cache) await cache.put(cle, reponse(JSON.stringify(res), 'application/json')).catch(() => {});
		return res;
	}

	return { prevoir, PAL, DBZ0, SEUIL, taux };
})();
