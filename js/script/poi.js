// Points de service (eau, toilettes, réparation, parking vélo) : configuration et couche carte
// partagées par les pages de service (services.js) et la page itinéraire (routePage.js).
// Dépend de ol.js. Expose SERVICES et POI (scripts classiques : pas d'autre nom global).
// Un fichier par service et par région : data/poi/<région>/<service>.geojson (pipeline/04_poi.py).

const SERVICES = {
	water: {
		title: 'Eau potable', desc: 'Fontaines, cimetières et sanitaires où remplir sa gourde.',
		color: ['--c-water', '#2E7DB5'], icon: 'water',
		types: {
			drinking_water: { label: 'Fontaine', plural: 'Fontaines', hint: 'Point d’eau potable' },
			graveyard: { label: 'Cimetière', plural: 'Cimetières', hint: 'Robinet généralement près de l’entrée' },
			toilet: { label: 'Sanitaires', plural: 'Sanitaires', hint: 'Lavabo probable' },
		},
	},
	toilet: {
		title: 'Trône Finder', desc: 'Toilettes publiques sur votre parcours.',
		color: ['--c-toilet', '#8A5A9E'], icon: 'toilet',
		types: { toilet: { label: 'Toilettes publiques', plural: 'Toilettes', hint: 'Sanitaires publics' } },
	},
	repair: {
		title: 'Réparation', desc: 'Magasins de vélo, loueurs et stations en libre-service, pour une réparation ou un dépannage.',
		color: ['--c-repair', '#C9822B'], icon: 'repair',
		types: {
			bicycle_shop: { label: 'Magasin vélo', plural: 'Magasins', hint: 'Vente et réparation' },
			bicycle_rental: { label: 'Location de vélos', plural: 'Location', hint: 'Loueur, dépannage possible' },
			repair_station: { label: 'Station de réparation', plural: 'Stations', hint: 'Outils et pompe en libre-service' },
		},
	},
	parking: {
		title: 'Parking vélo', desc: 'Arceaux et abris pour garer votre vélo.',
		color: ['--c-parking', '#3C8D5A'], icon: 'parking',
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

	const url = (id, region) => site(`data/poi/${region}/${id}.geojson`);

	// GeoJSON chargé une seule fois par service et par région ; chaque point porte `svc` et `stype`
	function load(id, region) {
		const k = `${region}/${id}`;
		return cache[k] || (cache[k] = fetch(url(id, region))
			.then(r => { if (!r.ok) throw new Error(`${url(id, region)} HTTP ${r.status}`); return r.json(); })
			.then(json => {
				const feats = new ol.format.GeoJSON().readFeatures(json);
				feats.forEach(f => { f.set('svc', id); f.set('stype', typeOf(id, f.getProperties())); });
				return feats;
			})
			.catch(err => { delete cache[k]; throw err; }));
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

	return { color, typeOf, url, load, singleStyle, clusterLayer };
})();
