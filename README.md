# Sauve ton slip

*Tout est dans le titre.* Par CyClo Bretagne.

Trouvez des toilettes, même hors ligne, et roulez proprement en Bretagne : le trajet sans pente est inclus
gratuitement !!

- **Trône Finder** : les toilettes publiques les plus proches, et l'itinéraire vélo pour y aller.
- Eau potable, réparation (magasins et loueurs), stationnement vélo.
- Itinéraires vélo calculés sur le téléphone, sans serveur : relief (MNT IGN 5 m), trafic, revêtement,
  mode « le plus plat possible », guidage GPS.
- Application web installable (PWA), qui fonctionne hors ligne.

À vos risques et périls : regardez la route, pas le téléphone.

## Fonctionnement

Site 100 % statique (HTML, CSS, JavaScript, sans framework). Le réseau cyclable de la Bretagne est
précalculé en tuiles binaires (`data/graph/`), chargées à la demande ; le calcul d'itinéraire (A*) se fait
dans le navigateur. Les fichiers de ce dépôt sont générés et publiés depuis un dépôt de travail séparé
(pipeline de données).

Site en ligne : <https://t-loree.github.io/sauve-ton-slip/>



## Licences

- Code : [GNU GPL v3](LICENSE).
- Données (`data/`) : ODbL 1.0, © contributeurs OpenStreetMap ; altitudes IGN – RGE ALTI®
  (Licence Ouverte Etalab 2.0). Détails : [DATA_LICENSE.md](DATA_LICENSE.md).
- OpenLayers (`js/lib/`) : BSD 2 clauses, voir [LICENSE-openlayers.md](js/lib/LICENSE-openlayers.md).
