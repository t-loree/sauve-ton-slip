// Racine du site, déduite de l'adresse de ce script (js/script/layout.js) : le site marche à la racine d'un
// domaine comme dans un sous-dossier (GitHub Pages : /sauve-ton-slip/). site('page/route/') -> adresse complète.
const SITE = new URL('../../', document.currentScript.src).href;
const site = p => SITE + p;

// En-tête (ordinateur) et barre d'onglets (smartphone) communs à toutes les pages.
// Chaque page indique sa section via <body data-page="...">.
(function () {
	const SECTIONS = [
		{ id: 'route', href: site('page/route/'), label: 'Itinéraire', icon: 'route' },
		{ id: 'water', href: site('page/water/'), label: 'Eau', long: 'Eau potable', icon: 'water' },
		{ id: 'toilet', href: site('page/trone-finder/'), label: 'Trône Finder', icon: 'toilet' },
		{ id: 'repair', href: site('page/repair/'), label: 'Réparation', icon: 'repair' },
		{ id: 'parking', href: site('page/parking/'), label: 'Parking', long: 'Parking vélo', icon: 'parking' },
	];
	const page = document.body.dataset.page;
	const icon = name => `<svg class="icon" aria-hidden="true"><use href="${site('img/icons.svg')}#i-${name}"/></svg>`;
	const cur = s => (s.id === page ? ' aria-current="page"' : '');

	const header = document.createElement('header');
	header.className = 'appbar';
	header.innerHTML = `
		<a class="brand" href="${site('page/')}"><img src="${site('img/logo.svg')}" alt=""><span class="brand-nom"><b>Sauve ton <span>slip</span></b><small>par CyClo Bretagne</small></span></a>
		<nav class="topnav" aria-label="Sections">
			${SECTIONS.map(s => `<a href="${s.href}"${cur(s)}>${icon(s.icon)}${s.long || s.label}</a>`).join('')}
		</nav>`;
	document.body.prepend(header);
	// météo à droite de la barre (meteo.js) : chargée après la barre, sans bloquer la page
	const meteo = document.createElement('script');
	meteo.src = site('js/script/meteo.js');
	document.body.append(meteo);

	const tabs = document.createElement('nav');
	tabs.className = 'tabbar';
	tabs.setAttribute('aria-label', 'Sections');
	tabs.innerHTML = SECTIONS.map(s => `<a href="${s.href}"${cur(s)}>${icon(s.icon)}<span>${s.label}</span></a>`).join('');
	document.body.append(tabs);

	if ('serviceWorker' in navigator) navigator.serviceWorker.register(site('sw.js'));

	// dessins animés (SMIL, accueil) : figés si l'utilisateur limite les animations
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) document.querySelectorAll('svg.art').forEach(s => s.pauseAnimations());

	// Première visite : avertissement « à vos risques et périls » (une seule fois par appareil)
	const CLE_RISQUES = 'sts-risques-v1';
	let vu = false;
	try { vu = localStorage.getItem(CLE_RISQUES) === '1'; } catch (e) { /* stockage bloqué : on avertit */ }
	if (!vu) {
		avertir({
			emoji: '⚠️',
			titre: 'À vos risques et périls !!!!',
			texte: 'Itinéraires et toilettes viennent de données ouvertes (OpenStreetMap) : une route peut être fermée, '
				+ 'un trône hors service. Respectez le code de la route, gardez les yeux sur la chaussée, '
				+ 'et prévoyez toujours un plan B (et du papier).',
			bouton: 'J’ai compris, je roule',
		}).then(() => { try { localStorage.setItem(CLE_RISQUES, '1'); } catch (e) { /* tant pis */ } });
	}
})();

// Fenêtre d'avertissement : avertir({ emoji, titre, texte, bouton }) -> Promise résolue à la fermeture.
function avertir({ emoji = '', titre, texte, bouton = 'OK' }) {
	return new Promise(resolve => {
		const d = document.createElement('dialog');
		d.className = 'alerte';
		d.innerHTML = `${emoji ? `<div class="alerte-emoji" aria-hidden="true">${emoji}</div>` : ''}
			<h2></h2><p></p><button class="btn btn-primary btn-lg" type="button" autofocus></button>`;
		d.querySelector('h2').textContent = titre;
		d.querySelector('p').textContent = texte;
		d.querySelector('button').textContent = bouton;
		d.querySelector('button').addEventListener('click', () => d.close());
		d.addEventListener('close', () => { d.remove(); resolve(); });
		document.body.append(d);
		d.showModal();
	});
}
