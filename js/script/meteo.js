// Météo dans la barre du haut (toutes les pages, chargé par layout.js) : température, vent au sol et humidité
// du modèle Météo-France (AROME en France, ARPEGE à La Réunion) via Open-Meteo ; un clic ouvre la fenêtre
// « Prévision pluie » : une carte avec le radar de −20 min à maintenant puis l'extrapolation jusqu'à +30 min
// (pluie.js), la probabilité de pluie en couche dessous, et des particules de vent au sol.
// Lieu : la position donnée par « Ma position » (arrondie à 0,1°, ~10 km, avant tout envoi), sinon le centre de la
// dernière région vue. OpenLayers et pluie.js ne sont chargés qu'à l'ouverture de la fenêtre.
// Réseau : 1 appel Open-Meteo par quart d'heure pour la barre (mis en cache), 1 appel de 16 points pour le vent
// et ~30 tuiles radar à chaque ouverture de la fenêtre.

(function () {
	const appbar = document.querySelector('.appbar');
	if (!appbar) return;

	const API = 'https://api.open-meteo.com/v1/forecast';
	const MODELE = 'meteofrance_seamless';
	const CLE_POS = 'sts-meteo-pos', CLE_METEO = 'sts-meteo', TTL = 15 * 60 * 1000;
	const CENTRES = { bretagne: [-4.10, 48.00], reunion: [55.45, -20.88] };   // repli : centre de la région
	const arrondi = v => Math.round(v * 10) / 10;
	const lire = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
	const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } };

	function lieu() {
		const p = lire(CLE_POS);
		if (p && Array.isArray(p.c)) return { c: p.c, perso: true };
		let r = 'bretagne';
		try { r = localStorage.getItem('sts-region') || r; } catch (e) { /* idem */ }
		return { c: CENTRES[r] || CENTRES.bretagne, perso: false };
	}
	const sansRadar = ([lon, lat]) => lat < 0 && lon > 40;   // La Réunion : RainViewer n'y a pas de radar

	// flèche du vent : pointe là où va le vent (direction météo + 180°)
	const fleche = deg => `<svg class="meteo-fl" viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate(${(deg + 180) % 360}deg)">`
		+ '<path d="M8 .5 L12 15 L8 12.2 L4 15 Z" fill="currentColor"/></svg>';
	const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
	const cardinal = d => CARD[Math.round(d / 45) % 8];

	// ---------- résumé dans la barre ----------
	const bouton = document.createElement('button');
	bouton.type = 'button';
	bouton.className = 'meteo';
	bouton.setAttribute('aria-haspopup', 'dialog');
	bouton.innerHTML = '<span class="meteo-txt">Météo</span><span class="meteo-pluie" aria-hidden="true">☂</span>';
	appbar.append(bouton);
	bouton.addEventListener('click', () => ouvrir());

	async function actuel(c) {
		const k = c.join(','), m = lire(CLE_METEO);
		if (m && m.k === k && Date.now() - m.t < TTL) return m.d;
		const url = `${API}?latitude=${c[1]}&longitude=${c[0]}&models=${MODELE}&timezone=auto`
			+ '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
		const d = (await (await fetch(url)).json()).current;
		if (d?.temperature_2m == null) throw new Error('pas de données');
		ecrire(CLE_METEO, { k, t: Date.now(), d });
		return d;
	}
	function texte(d) {
		return `${Math.round(d.temperature_2m)} °C, vent ${cardinal(d.wind_direction_10m)} ${Math.round(d.wind_speed_10m)} km/h`
			+ ` (rafales ${Math.round(d.wind_gusts_10m)}), humidité ${Math.round(d.relative_humidity_2m)} %`;
	}
	async function majBarre() {
		const { c, perso } = lieu();
		try {
			const d = await actuel(c);
			bouton.querySelector('.meteo-txt').innerHTML = `<b>${Math.round(d.temperature_2m)}°</b>`
				+ `<span class="meteo-vent">${fleche(d.wind_direction_10m)}${Math.round(d.wind_speed_10m)}<small> km/h</small></span>`
				+ `<span class="meteo-hum">${Math.round(d.relative_humidity_2m)}<small> %</small></span>`;
			bouton.title = `${perso ? 'À votre position' : 'Au centre de la région'} : ${texte(d)} (Météo-France via Open-Meteo). Cliquer : prévision de pluie`;
			return d;
		} catch (e) {
			bouton.querySelector('.meteo-txt').textContent = 'Météo';
			bouton.title = 'Météo indisponible (hors ligne ?). Cliquer : prévision de pluie';
			return null;
		}
	}
	majBarre();
	document.addEventListener('visibilitychange', () => { if (!document.hidden) majBarre(); });

	// ---------- fenêtre « Prévision pluie » ----------
	const charger = src => new Promise((ok, ko) => {
		const s = document.createElement('script');
		s.src = src; s.onload = ok; s.onerror = ko;
		document.head.append(s);
	});
	let deps = null;   // chargé une seule fois, même si la légende et la carte le demandent en même temps
	const dependances = () => deps || (deps = chargerDeps().catch(e => { deps = null; throw e; }));
	async function chargerDeps() {
		if (typeof ol === 'undefined') {
			if (!document.querySelector('link[href$="css/ol.css"]')) {
				const l = document.createElement('link');
				l.rel = 'stylesheet'; l.href = site('css/ol.css');
				document.head.append(l);
			}
			await charger(site('js/lib/ol.js'));
		}
		if (typeof Pluie === 'undefined') await charger(site('js/script/pluie.js'));
	}

	let dlg = null;
	async function ouvrir() {
		dlg?.remove();
		dlg = document.createElement('dialog');
		dlg.className = 'meteo-dlg';
		dlg.innerHTML = `
			<div class="meteo-tete"><h2>Prévision pluie</h2><button type="button" class="btn meteo-fermer" aria-label="Fermer">✕</button></div>
			<p class="meteo-ici small"></p>
			<div class="meteo-cartes">
				<div class="meteo-carte"><div class="meteo-ol"></div><canvas class="meteo-part"></canvas><span class="meteo-etiq">Radar, puis extrapolation</span></div>
				<div class="meteo-attente">Calcul de la prévision…</div>
			</div>
			<div class="meteo-temps"><button type="button" class="btn meteo-play" aria-label="Lecture">▶</button>
				<div class="meteo-curseur"><input type="range" min="0" max="5" value="2" aria-label="Heure">
					<svg class="meteo-graph" role="img"></svg></div><output></output></div>
			<p class="meteo-proba"></p>
			<div class="meteo-legende tiny"><span>pluie</span><canvas width="138" height="10"></canvas><span>forte</span>
				<span class="meteo-sep"></span><span>risque</span><canvas width="60" height="10"></canvas><span>100 %</span></div>
			<p class="tiny">Sous le curseur, au point : barres = pluie (mm/h), fond violet = risque de pluie.
				Prévision par extrapolation du radar : indicative, les averses naissent et meurent.
				Radar © RainViewer · Météo-France (AROME / ARPEGE) via Open-Meteo · position arrondie à ~10 km.</p>`;
		document.body.append(dlg);
		const $ = s => dlg.querySelector(s);
		let anim = null, timer = null, carte = null;
		$('.meteo-fermer').addEventListener('click', () => dlg.close());
		dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // clic hors de la fenêtre
		dlg.addEventListener('close', () => { cancelAnimationFrame(anim); clearInterval(timer); dlg.remove(); dlg = null; });
		dlg.showModal();
		legende($('.meteo-legende'));

		const { c, perso } = lieu();
		const d = await majBarre();
		const ici = $('.meteo-ici');
		ici.textContent = d ? `${perso ? 'À votre position' : 'Au centre de la région'} : ${texte(d)}. ` : 'Météo indisponible. ';
		const pos = document.createElement('button');
		pos.type = 'button'; pos.className = 'btn btn-sm'; pos.textContent = '📍 Ma position';
		ici.append(pos);
		pos.addEventListener('click', () => {
			pos.disabled = true; pos.textContent = 'Localisation…';
			navigator.geolocation.getCurrentPosition(p => {
				ecrire(CLE_POS, { c: [arrondi(p.coords.longitude), arrondi(p.coords.latitude)] });
				try { localStorage.removeItem(CLE_METEO); } catch (e) { /* idem */ }
				ouvrir();
			}, () => { pos.textContent = 'Position refusée'; }, { maximumAge: 600000, timeout: 15000 });
		});

		try { await dependances(); } catch (e) { $('.meteo-attente').textContent = 'Carte indisponible (hors ligne ?)'; return; }
		if (!dlg) return;

		// carré de ~40 km autour du point (degrés de longitude plus courts que ceux de latitude)
		const dlat = 20 / 111.2, dlon = dlat / Math.cos(c[1] * Math.PI / 180);
		const vue = new ol.View({ projection: 'EPSG:4326', center: c, zoom: 11 });
		const point = new ol.layer.Vector({
			source: new ol.source.Vector({ features: [new ol.Feature(new ol.geom.Point(c))] }),
			style: new ol.style.Style({ image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#E8A33D' }),
				stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) }) }),
		});
		const fondCarte = () => new ol.layer.Tile({ source: new ol.source.OSM() });
		// une seule carte : probabilité (violet) dessous, radar / extrapolation par-dessus
		const radar = new ol.layer.Image({ opacity: 0.85 }), proba = new ol.layer.Image({ opacity: 0.7 });
		// carte fixe : ni déplacement ni zoom (interactions vides), rien à recharger après l'ouverture
		carte = new ol.Map({ target: $('.meteo-ol'), view: vue, layers: [fondCarte(), proba, radar, point],
			interactions: [], controls: [new ol.control.Attribution({ collapsible: true })] });

		vue.fit([c[0] - dlon, c[1] - dlat, c[0] + dlon, c[1] + dlat], { size: carte.getSize() });
		vent(carte, c, $('.meteo-part'), f => { anim = f; });

		if (sansRadar(c)) { $('.meteo-attente').textContent = 'Pas de radar de pluie disponible ici (seulement le vent).'; return; }
		let res;
		try { res = await Pluie.prevoir(c[0], c[1]); } catch (e) { $('.meteo-attente').textContent = 'Radar indisponible (hors ligne ?)'; return; }
		if (!dlg) return;
		$('.meteo-attente').remove();

		const curseur = $('input[type=range]'), sortie = $('output');
		curseur.max = res.etapes.length - 1;
		// images du résultat (peut venir du cache) -> sources OpenLayers, posées en EPSG:3857 sur l'étendue du bloc
		const src = url => url && new ol.source.ImageStatic({ url, projection: 'EPSG:3857', imageExtent: res.etendue, attributions: 'Radar © RainViewer' });
		const sources = res.etapes.map(e => ({ img: src(e.img), proba: src(e.proba) }));
		const graphe = graphique($('.meteo-graph'), res.etapes, k => { arreter(); montrer(k); });
		const heure = t => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
		function montrer(k) {
			const e = res.etapes[k];
			curseur.value = k;
			radar.setSource(sources[k].img);
			proba.setSource(e.min > 0 ? sources[k].proba : null);   // la probabilité n'a de sens que pour la prévision
			graphe(k);
			$('.meteo-etiq').textContent = e.min > 0 ? 'Extrapolation · en violet : risque de pluie' : 'Radar observé';
			sortie.textContent = `${e.min > 0 ? '+' : e.min < 0 ? '−' : ''}${Math.abs(e.min)} min · ${heure(e.t)}`
				+ (e.min > 0 ? ' · prévu' : e.min < 0 ? ' · observé' : ' · maintenant');
			sortie.classList.toggle('prevu', e.min > 0);
		}
		let k = res.etapes.findIndex(e => e.min === 0);
		const jouer = () => { timer = setInterval(() => { k = (k + 1) % res.etapes.length; montrer(k); }, 1000); $('.meteo-play').textContent = '❚❚'; };
		function arreter() { clearInterval(timer); timer = null; $('.meteo-play').textContent = '▶'; }
		$('.meteo-play').addEventListener('click', () => (timer ? arreter() : jouer()));
		curseur.addEventListener('input', () => { arreter(); k = +curseur.value; montrer(k); });
		montrer(k);   // maintenant ; la lecture se lance avec ▶

		const pc = v => v == null ? '?' : `${Math.round(v * 100)} %`;
		const p = res.probaIci;
		$('.meteo-proba').innerHTML = (res.pluieMaintenant ? '<b>Il pleut en ce moment ici.</b> ' : '')
			+ `Risque de pluie ${perso ? 'à votre position' : 'au centre de la région'} : `
			+ `<b>${pc(p[10])}</b> dans 10 min · <b>${pc(p[20])}</b> dans 20 min · <b>${pc(p[30])}</b> dans 30 min`
			+ (res.vitesse ? `<br><span class="tiny">Les averses se déplacent vers le ${cardinal(res.cap)} à ${Math.round(res.vitesse)} km/h.</span>`
				: res.sec ? '<br><span class="tiny">Pas assez de pluie dans le secteur pour mesurer un déplacement.</span>' : '');
	}

	// petit graphique sous le curseur, une colonne par image : fond violet = risque de pluie (prévision), barre =
	// pluie au point en mm/h (racine carrée, plafonnée à 8 mm/h), de la couleur du radar ; passé plus pâle.
	// Renvoie dessiner(k) (k = image affichée) ; un clic sur une colonne appelle choisir(k).
	function graphique(svg, etapes, choisir) {
		const NS = 'http://www.w3.org/2000/svg', H = 38, HL = 13, PAD = 9, n = etapes.length;
		const el = (nom, at) => { const e = document.createElementNS(NS, nom); for (const a in at) e.setAttribute(a, at[a]); svg.append(e); return e; };
		const nb = v => v.toLocaleString('fr-FR', { maximumFractionDigits: v < 1 ? 1 : 0 });
		const couleur = mm => {
			// couleur du radar, mais au moins le premier bleu (20 dBZ) : le beige des faibles pluies ne se voit pas sur le violet
			const P = Pluie.PAL, q = P[Math.max(20 - Pluie.DBZ0, Math.min(P.length - 1, Math.round(10 * Math.log10(200 * mm ** 1.6)) - Pluie.DBZ0))];
			return `rgb(${q[0]},${q[1]},${q[2]})`;
		};
		const signe = m => (m > 0 ? '+' : m < 0 ? '−' : '') + Math.abs(m);
		svg.setAttribute('aria-label', 'Pluie au point : ' + etapes.map(e => `${signe(e.min)} min ${nb(e.mm || 0)} mm/h`
			+ (e.p != null ? ` risque ${Math.round(e.p * 100)} %` : '')).join(', '));
		let pas = 1;
		svg.addEventListener('click', ev => {
			const r = svg.getBoundingClientRect(), i = Math.round((ev.clientX - r.left - PAD) / pas);
			if (i >= 0 && i < n) choisir(i);
		});
		return sel => {
			const w = svg.clientWidth || 240;
			pas = (w - 2 * PAD) / (n - 1);
			const cw = Math.min(22, pas * 0.62);
			svg.setAttribute('viewBox', `0 0 ${w} ${H + HL}`);
			svg.replaceChildren();
			el('rect', { x: PAD + sel * pas - cw / 2 - 3, y: 0, width: cw + 6, height: H + HL, rx: 6, class: 'g-sel' });
			el('line', { x1: 0, x2: w, y1: H + 0.5, y2: H + 0.5, class: 'g-base' });
			etapes.forEach((e, i) => {
				const x = PAD + i * pas;
				const titre = `${signe(e.min)} min : ${e.mm ? nb(e.mm) + ' mm/h' : 'sec'}` + (e.p != null ? `, risque ${Math.round(e.p * 100)} %` : '');
				if (e.p != null && e.p > 0.005) {
					const h = Math.max(2, e.p * H);
					el('rect', { x: x - cw / 2, y: H - h, width: cw, height: h, rx: 4, class: 'g-proba', 'fill-opacity': (0.14 + 0.32 * e.p).toFixed(2) })
						.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: titre }));
				}
				if (e.mm > 0.05) {
					const h = Math.max(2, Math.sqrt(Math.min(e.mm, 8) / 8) * H);
					el('rect', { x: x - cw * 0.28, y: H - h, width: cw * 0.56, height: h, rx: 2.5, fill: couleur(e.mm), class: 'g-mm' + (e.min <= 0 ? ' passe' : '') })
						.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: titre }));
					if (i === sel) el('text', { x, y: Math.max(8, H - h - 2), class: 'g-val' }).textContent = nb(e.mm);
				}
				el('text', { x, y: H + HL - 2, class: 'g-lab' + (i === sel ? ' sel' : '') + (e.min > 0 ? ' prevu' : '') }).textContent = signe(e.min);
			});
		};
	}

	// échelle de couleurs : palette radar (sans le beige le plus faible) et probabilité
	function legende(div) {
		const [cr, cp] = div.querySelectorAll('canvas');
		const dessiner = () => {
			if (typeof Pluie === 'undefined') return;
			const g = cr.getContext('2d'), P = Pluie.PAL.slice(10), w = cr.width / P.length;
			P.forEach((p, k) => { g.fillStyle = `rgba(${p[0]},${p[1]},${p[2]},${p[3] / 255})`; g.fillRect(k * w, 0, w + 1, cr.height); });
		};
		const gp = cp.getContext('2d');
		for (let x = 0; x < cp.width; x++) {
			const v = 0.1 + 0.9 * x / cp.width;
			gp.fillStyle = `rgba(${200 - 140 * v},${120 - 110 * v},${230 - 60 * v},${(70 + 185 * v) / 255})`;
			gp.fillRect(x, 0, 1, cp.height);
		}
		dessiner();
		if (typeof Pluie === 'undefined') dependances().then(dessiner).catch(() => {});
	}

	// ---------- particules de vent au sol, peu nombreuses ----------
	// grille 4×4 sur la vue (une requête Open-Meteo, mise en cache 15 min), interpolée ; 60 particules au plus
	async function vent(map, c, cvs, setAnim) {
		const ext = 1.2, n = 4, la = [], lo = [];
		for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { la.push(arrondi(c[1] - ext * 0.7 + j * 1.4 * ext / (n - 1))); lo.push(arrondi(c[0] - ext + i * 2 * ext / (n - 1))); }
		const cle = 'sts-meteo-vent', m = lire(cle), k = c.join(',');
		let pts;
		if (m && m.k === k && Date.now() - m.t < TTL) pts = m.p;
		else {
			try {
				const url = `${API}?latitude=${la.join(',')}&longitude=${lo.join(',')}&models=${MODELE}&current=wind_speed_10m,wind_direction_10m`;
				let j = await (await fetch(url)).json();
				if (!Array.isArray(j)) j = [j];
				pts = j.map(p => [p.current.wind_speed_10m, p.current.wind_direction_10m]);
				ecrire(cle, { k, t: Date.now(), p: pts });
			} catch (e) { return; }
		}
		// vecteur (u vers l'est, v vers le nord) en km/h
		const uv = pts.map(([s, d]) => { const a = d * Math.PI / 180; return [-s * Math.sin(a), -s * Math.cos(a)]; });
		const lon0 = lo[0], lat0 = la[0], dlon = (lo[n - 1] - lon0) / (n - 1), dlat = (la[n * (n - 1)] - lat0) / (n - 1);
		const champ = (lon, lat) => {
			const fx = Math.max(0, Math.min(n - 1.001, (lon - lon0) / dlon)), fy = Math.max(0, Math.min(n - 1.001, (lat - lat0) / dlat));
			const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, q = (a, b) => uv[b * n + a];
			return [0, 1].map(k => (q(i, j)[k] * (1 - tx) + q(i + 1, j)[k] * tx) * (1 - ty) + (q(i, j + 1)[k] * (1 - tx) + q(i + 1, j + 1)[k] * tx) * ty);
		};
		const ctx = cvs.getContext('2d');
		let W = 0, H = 0, parts = [];
		const taille = () => {
			const dpr = window.devicePixelRatio || 1;
			W = cvs.clientWidth; H = cvs.clientHeight;
			cvs.width = W * dpr; cvs.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			parts = Array.from({ length: Math.round(Math.min(60, W * H / 1500)) }, () => ({ x: Math.random() * W, y: Math.random() * H, age: Math.random() * 80 }));
		};
		taille();
		map.getView().on('change', () => ctx.clearRect(0, 0, W, H));
		const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;
		function image() {
			ctx.globalCompositeOperation = 'destination-in';
			ctx.fillStyle = 'rgba(0,0,0,.88)'; ctx.fillRect(0, 0, W, H);   // traînées courtes
			ctx.globalCompositeOperation = 'source-over';
			ctx.strokeStyle = 'rgba(30,60,90,.45)'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
			for (const p of parts) {
				const co = map.getCoordinateFromPixel([p.x, p.y]);
				if (!co) continue;
				const [u, v] = champ(co[0], co[1]), kmh = Math.hypot(u, v);
				const dx = u / Math.max(Math.cos(co[1] * Math.PI / 180), 0.1), dy = -v, nrm = Math.hypot(dx, dy) || 1, pas = 0.3 + kmh * 0.04;
				const nx = p.x + dx / nrm * pas, ny = p.y + dy / nrm * pas;
				ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
				p.x = nx; p.y = ny;
				if (++p.age > 110 || nx < 0 || ny < 0 || nx > W || ny > H) { p.x = Math.random() * W; p.y = Math.random() * H; p.age = 0; }
			}
			if (!reduit) setAnim(requestAnimationFrame(image));
		}
		image();
	}
})();
