# 15 minutos. ¿Para quién? · Madrid

![Vista previa del mapa](og.png)

Mapa interactivo que muestra hasta dónde llegas andando por Madrid en un tiempo dado, y cómo cambia según tu velocidad, si puedes usar escaleras y si tienes en cuenta las cuestas. Los mismos 15 minutos no llegan igual de lejos para todo el mundo.

**Pruébalo:** https://pablolamiquiz.github.io/15--minutos-madrid/

## Qué hace

- Haz clic en el mapa, arrastra el punto o busca una calle, estación o parque.
- Ajusta el tiempo (5 a 30 min) y la velocidad al caminar (0,8 a 1,8 m/s, el rango del metaestudio de [Giannoulaki y Christoforou, 2024](https://www.mdpi.com/2818476)).
- Marca «Evitar escaleras» para quitar los tramos de escaleras mapeados, y «Escaleras» para verlos en rojo en el mapa.
- **Cuestas**: «Tener en cuenta las cuestas» hace que subir sea más lento según la función de Tobler (un 16 % más lento con un 5 % de pendiente, un 30 % con un 10 %). «Evitar cuestas de más del X %» quita los tramos más empinados; el 6 % es el máximo de un itinerario peatonal accesible según la Orden TMA/851/2021. «Cuestas de más del X %» las marca en morado.
- **Metro**: las estaciones llevan una letra (M, C, ML) y en las de Metro cuenta la llegada a cualquiera de sus bocas. Si evitas escaleras, una estación accesible solo cuenta si llegas a una boca etiquetada como accesible (con ascensor).
- En color, las calles que alcanzas con tus ajustes; en gris, las que alcanzaría en el mismo tiempo alguien a 1,4 m/s que puede usar escaleras.
- El panel cuenta servicios (alimentación, salud, educación, parques, cafés y restaurantes), bancos, paradas de bus y estaciones al alcance, y cuántas estaciones están etiquetadas como accesibles.
- «Compartir esta vista» guarda el punto y los ajustes en la dirección.
- En español y en inglés.

## Cómo funciona

No hay servidor. La red peatonal de Madrid viaja con la página (`data/`, unos 2,8 MB comprimidos) y el navegador calcula el recorrido con el algoritmo de Dijkstra. El mapa base también se dibuja en el navegador a partir de los mismos datos, así que no depende de ningún servicio de teselas.

- `data/graph.bin.gz`: red peatonal (145.487 nodos y 207.507 tramos; 4.536 son escaleras), más las líneas de contexto del mapa (autovías, tren, ríos).
- `data/extra.json.gz`: 39.120 puntos de interés, nombres, parques y agua, el tipo de cada estación y 508 bocas de metro (OpenStreetMap, 7 de octubre de 2026).
- `data/elev.bin.gz`: altura de cada cruce, del modelo digital del terreno MDT05 del IGN (5 m, servicio WCS de la IDEE), suavizada y sin los «pozos» de los puentes. Si falta este fichero, la página funciona igual pero sin cuestas.
- Zona cubierta: 7 km alrededor de la Puerta del Sol (prácticamente todo el interior de la M-30 y parte de fuera).
- Datos: extracto de OpenStreetMap de Geofabrik, 30 de septiembre de 2026.

Para verlo en tu ordenador, abre un Terminal en esta carpeta y ejecuta `python3 -m http.server 8000`. Después ve a http://localhost:8000 (abrir `index.html` con doble clic no funciona, porque la página tiene que cargar los ficheros de `data/`).

## Limitaciones

- No incluye transporte público, bordillos, estado de las aceras ni iluminación. «Evitar escaleras» y «Evitar cuestas» juntos no equivalen a una ruta en silla de ruedas.
- La pendiente de cada tramo es la media entre sus dos cruces (mínimo 20 m de longitud): una calle que sube y baja dentro de la misma manzana parece más llana, y junto a algunos puentes puede haber pequeños errores.
- OpenStreetMap está incompleto en algunos sitios. Una estación solo cuenta como accesible si está etiquetada `wheelchair=yes`, y muchas no tienen la etiqueta.
- Los servicios se asignan al cruce más cercano y los parques cuentan como un solo punto, así que los recuentos cerca del borde son aproximados.

## Ideas para seguir

- Inventario oficial de bancos del Ayuntamiento ([datos.madrid.es](https://datos.madrid.es/dataset/300095-0-mobiliario-bancos)).
- Fuentes de agua, sombra, aseos.
- Actualizar los datos de OpenStreetMap periódicamente.

## Créditos y licencias

- Basado en [«15 minutes. For whom?»](https://github.com/martincantcode/15-minutes) de Martin Bangratz, a su vez inspirado en la ciudad de 15 minutos de Carlos Moreno. Código bajo licencia MIT (ver `LICENSE`). Esta versión adapta la página a Madrid y añade las cuestas, las bocas de metro, el buscador, las paradas de bus, el mapa base propio y la versión en inglés.
- Elevación: MDT05 © Instituto Geográfico Nacional, CC BY 4.0 [scne.es](https://www.scne.es).
- Datos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright). Los ficheros de `data/` son una base de datos derivada de OpenStreetMap y están disponibles bajo la [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- Leaflet (BSD-2), fflate (MIT) y las tipografías Fraunces y Public Sans (SIL OFL 1.1): ver `vendor/LICENSES.md`.

---

## English

Interactive map of how far you can walk in Madrid in a given time, and how that changes with walking speed, avoiding stairs and slopes (from the IGN MDT05 terrain model, using Tobler's hiking function), with Metro reach measured to station entrances. Based on [“15 minutes. For whom?”](https://github.com/martincantcode/15-minutes) by Martin Bangratz (MIT). Everything runs in the browser on OpenStreetMap data (© OpenStreetMap contributors, ODbL) bundled in `data/`; there is no server and no tile service. Covers 7 km around Puerta del Sol. Use the ES/EN switch on the page.
