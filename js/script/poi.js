// Points de service (eau, toilettes, réparation, parking vélo) : configuration et couche carte
// partagées par les pages de service (services.js) et la page itinéraire (routePage.js).
// Dépend de ol.js. Expose SERVICES et POI (scripts classiques : pas d'autre nom global).

const SERVICES = {
	water: {
		title: 'Eau potable', desc: 'Fontaines, cimetières et sanitaires où remplir sa gourde.',
		url: site('data/water_all_pls.geojson'), color: ['--c-water', '#2E7DB5'], icon: 'water',
		types: {
			drinking_water: { label: 'Fontaine', plural: 'Fontaines', hint: 'Point d’eau potable' },
			graveyard: { label: 'Cimetière', plural: 'Cimetières', hint: 'Robinet généralement près de l’entrée' },
			toilet: { label: 'Sanitaires', plural: 'Sanitaires', hint: 'Lavabo probable' },
		},
	},
	toilet: {
		title: 'Trône Finder', desc: 'Toilettes publiques sur votre parcours.',
		url: site('data/toilet_pls.geojson'), color: ['--c-toilet', '#8A5A9E'], icon: 'toilet',
		types: { toilet: { label: 'Toilettes publiques', plural: 'Toilettes', hint: 'Sanitaires publics' } },
	},
	repair: {
		title: 'Réparation', desc: 'Magasins de vélo et loueurs, pour une réparation ou un dépannage.',
		url: site('data/repair_pls.geojson'), color: ['--c-repair', '#C9822B'], icon: 'repair',
		types: {
			bicycle_shop: { label: 'Magasin vélo', plural: 'Magasins', hint: 'Vente et réparation' },
			bicycle_rental: { label: 'Location de vélos', plural: 'Location', hint: 'Loueur, dépannage possible' },
		},
	},
	parking: {
		title: 'Parking vélo', desc: 'Arceaux et abris pour garer votre vélo.',
		url: site('data/parking_pls.geojson'), color: ['--c-parking', '#3C8D5A'], icon: 'parking',
		types: { _: { label: 'Stationnement vélo', plural: 'Stationnements', hint: 'Arceaux ou abri' } },
	},
};

const POI = (() => {
	const cache = {};

	// couleur du service : variable CSS (thème clair / sombre), sinon valeur de secours
	const color = id => getComputedStyle(document.documentElement).getPropertyValue(SERVICES[id].color[0]).trim()
		|| SERVICES[id].color[1];

	// type d'un point d'après fclass ; inconnu ou absent => premier type du service
	const typeOf = (id, props) => {
		const types = SERVICES[id].types;
		return (props.fclass && types[props.fclass]) ? props.fclass : Object.keys(types)[0];
	};

	// GeoJSON chargé une seule fois par service ; chaque point porte `svc` et `stype`
	function load(id) {
		return cache[id] || (cache[id] = fetch(SERVICES[id].url)
			.then(r => { if (!r.ok) throw new Error(`${SERVICES[id].url} HTTP ${r.status}`); return r.json(); })
			.then(json => {
				const feats = new ol.format.GeoJSON().readFeatures(json);
				feats.forEach(f => { f.set('svc', id); f.set('stype', typeOf(id, f.getProperties())); });
				return feats;
			})
			.catch(err => { delete cache[id]; throw err; }));
	}

	// pastille d'un point isolé : disque coloré + glyphe blanc
	const singleStyle = (id, radius = 16) => [
		new ol.style.Style({ image: new ol.style.Circle({ radius, fill: new ol.style.Fill({ color: color(id) }), stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }) }) }),
		new ol.style.Style({ image: new ol.style.Icon({ src: site(`img/glyph/${SERVICES[id].icon}.svg`), scale: 0.4 * radius / 16 }) }),
	];

	// couche groupée (cluster) d'un service ; les points se mettent dans la source renvoyée
	function clusterLayer(id, { distance = 44, radius = 16, zIndex } = {}) {
		const source = new ol.source.Vector();
		const single = singleStyle(id, radius);
		const fill = new ol.style.Fill({ color: color(id) });
		const groups = {};
		const layer = new ol.layer.Vector({
			source: new ol.source.Cluster({ distance, source }),
			zIndex,
			style: f => {
				const n = f.get('features').length;
				if (n === 1) return single;
				return groups[n] || (groups[n] = new ol.style.Style({
					image: new ol.style.Circle({ radius: radius - 1 + Math.min(n, 30) * 0.4, fill, stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.9)', width: 3 }) }),
					text: new ol.style.Text({ text: String(n), fill: new ol.style.Fill({ color: '#fff' }), font: '700 13px system-ui, sans-serif' }),
				}));
			},
		});
		layer.set('svc', id);
		return { layer, source };
	}

	return { color, typeOf, load, singleStyle, clusterLayer };
})();
