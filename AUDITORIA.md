# Auditoría · 15 minutos Madrid (8 de octubre de 2026)

Rama: `auditoria-pendientes-servicios`. Estado: **en revisión, incompleta**. Este documento separa lo que se ha corregido y comprobado de lo que queda pendiente, y no da por validado nada que solo reproduzca sus propios resultados.

## 1. Hallazgos, clasificados

### Errores de implementación (versión publicada v5)

| # | Problema | Efecto | Estado |
|---|---|---|---|
| E1 | La pendiente de un tramo era el desnivel entre las alturas de sus dos cruces (MDT05 del IGN, 5 m) dividido entre `max(L, 20 m)` | Ignora subidas y bajadas dentro del tramo. En puentes y junto a muros, un cruce toma la cota del terreno de abajo. | Corregido en `build/slopes.mjs`; falta publicarlo en la web |
| E2 | El origen se unía en línea recta a **todos** los cruces a menos de 60–400 m (`nodesNear`) | Podía «saltar» escaleras, muros o tramos excluidos sin recorrerlos | Diseño corregido (proyección sobre el tramo permitido más cercano); falta implementarlo en `index.html` |
| E3 | Cada servicio se asignaba al cruce más cercano, sin mirar si ese cruce era alcanzable por tramos permitidos | Lo mismo que E2 para los destinos | Corregido en el proceso (`attachDestinations`: 2 tramos más cercanos con posición, o accesos reales en parques y recintos); falta en la web |
| E4 | Los parques contaban como un punto (centroide) | Un parque grande se «alcanzaba» solo al llegar a su centro | Corregido: accesos = puntos donde los caminos cruzan el borde |
| E5 | No había un proceso de generación reproducible en el repositorio | No se podían auditar fuentes, fechas ni parámetros | Corregido: `build/` (Node ≥ 18 o navegador) |
| E6 | La pendiente era la misma en los dos sentidos para el filtro, y para el tiempo solo se usaba la cuerda entre cruces | | Corregido: factores de tiempo distintos al subir y al bajar (`tf`/`tb`) por trozo |

### Limitaciones de los datos

- **MDT municipal**: viene de una TIN de elementos cartográficos «a cota suelo» (vuelo de 2023, actualizado en 2025). El fichero del zip se llama `MDT2024_1m.tif`; el mosaico de 1 m es un remuestreo por vecino más próximo del de 10 cm. El error medio cuadrático absoluto declarado en Z es de 0,40 m. Ese valor es absoluto, y para la pendiente cuenta el error relativo entre puntos cercanos, que no está documentado. Sobre los tableros de puentes (Bailén) el modelo da la cota del tablero.
- **OSM**: muchos puentes y pasos elevados no llevan `bridge=*` (el tramo de Bailén sobre el viaducto no lo lleva). La geometría de aceras y calles tiene errores de varios metros.
- **Servicios**: son elementos de OpenStreetMap, no un censo. Ver la sección 4.

### Incertidumbre que no se puede resolver con estos datos

- Sin trabajo de campo no se puede saber si un tramo cumple la Orden TMA/851/2021. **El filtro de pendiente no es una certificación de accesibilidad.**
- En los tramos junto a muros o a otra cota (marcados como «discontinuidad»), el modelo no dice por qué nivel va el peatón.
- Para dos de los seis casos (San Vicente y José Ortega y Gasset), el tramo de la v5 ya no existe en la red actual y la geometría es aproximada.

## 2. Nuevo método de pendientes (`build/slopes.mjs`)

- **Fuente**: `SPA_28079_SERVICIO_MDT_MOSAICO_2025`, en https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2025/MDT/MOSAICO/MDT_1m.zip (1.516.568.778 bytes, `Last-Modified: 15/10/2025`). Se usa el nivel de 2 m del COG, leído en flujo sin descargar el fichero entero (unos 356 MB).
- **Perfil**: una muestra cada 2 m siguiendo la geometría real del tramo, más muestras a ±3 m en perpendicular cada 4 m. Los tramos de menos de 10 m se prolongan para medir siempre al menos 10 m.
- **Pendiente para barreras**: el máximo, a lo largo del tramo, de la pendiente por mínimos cuadrados en ventanas de 10 m.
  - Por qué 10 m: es la escala de una rampa según la TMA/851/2021 (art. 14: tramos de hasta 9 m con un 10 % o un 8 %).
  - Por qué mínimos cuadrados: no amplifica el ruido de un único punto.
  - No hay longitud mínima artificial (se elimina `max(L, 20)`).
  - No hay recortes ni excepciones por nombre de calle.
- **Pendiente para el tiempo**: se aplica la función de Tobler a cada intervalo de 2 m en el sentido de la marcha, con factores distintos para subir y para bajar (`tf`/`tb`).
- **Estructuras** (`bridge`, `tunnel` salvo `building_passage`, `indoor`, `location=underground|overground`): no se usa el terreno. La altura de sus extremos se interpola por la red (armónica) y queda marcada como «estructura».
- **Discontinuidades**: se marcan cuando el terreno salta más de 0,5 m entre muestras a 2 m, o cuando hay más de 1,5 m de diferencia entre ±3 m en perpendicular (muro, talud u otra cota).
- **Datos ausentes**: se marcan; no se convierten en llano en silencio.
- **Partición de tramos**: cada tramo se parte donde cambia la clase (umbrales del 4, 6, 8, 10 y 12 %). Los trozos de menos de 6 m se unen al vecino de clase mayor, que es el criterio conservador. Al partir se mantienen la longitud (comprobado al milímetro), las conexiones y el dibujo.
- **Banderas de calidad por tramo**: 1 estructura, 2 discontinuidad, 4 sin dato, 8 `layer≠0`.

## 3. Validación de los seis casos (`data/audit/slope_cases.csv`)

La referencia es el modelo municipal de **10 cm** (consultas `GetFeatureInfo` al WMS `MDT_2025` cada 1 m). Esto contrasta el remuestreo y la geometría, no la exactitud del modelo frente al terreno real: es la misma fuente.

| Tramo | v5 | Revisor | 10 cm: cuerda | 10 cm: máx. en 10 m | **Nuevo (2 m)** | Diagnóstico |
|---|---|---|---|---|---|---|
| Bailén (22 m) | 9,0 % | 0,1 % | 0,0 % | 0,1 % | **0,4 %** | Artefacto de la v5 (el cruce tomaba la cota bajo el viaducto) |
| Cuesta de la Vega (9 m) | 23,5 % | 0,6 % | 2,3 % | – | **2,1 %** | Artefacto de la v5 |
| San Vicente (66 m)* | 9,6 % | 4,9 % | 4,3 % | 7,3 % | **7,9 %** | Pendiente media del 4 % con un tramo local cercano al 8 % |
| Segovia (55 m) | 6,0 % | 6,3 % | 6,2 % | 7,7 % | **7,8 %** | Real; la media ocultaba el máximo |
| Atocha (24 m) | 9,1 % | 7,2 % | −7,1 % | 7,5 % | **8,1 %** | Real; la v5 la sobrestimaba |
| José Ortega y Gasset (62 m)* | 6,1 % | 6,8 % | 6,9 % | 9,8 % | **10,3 %** | Real, con un máximo local |

\* Geometría aproximada.

- Diferencia entre el nivel de 2 m y el modelo de 10 cm en estos perfiles: error cuadrático medio de 2 a 15 cm.
- El método nuevo da un máximo entre 0,1 y 0,6 puntos por encima del de 10 cm. El máximo de ventanas es sensible al ruido y ese sesgo es conservador. Queda documentado y no se ha ajustado.
- No se han ajustado los parámetros para reproducir estos valores ni los resultados anteriores (−41 %, −55 %, −73 %).

## 4. Servicios

Etiquetas por categoría (`build/osm_build.mjs`, `RULES`). Se aplica la primera regla que coincide:

- **Alimentación**: `shop=supermarket|convenience|greengrocer|bakery|butcher`
- **«Salud»**: `amenity=pharmacy|doctors|clinic|hospital|dentist`. Incluye consultas y clínicas privadas, así que la etiqueta debería decir «farmacias, consultas y hospitales» y no sugerir «centros de salud».
- **«Educación»**: `amenity=school|kindergarten|library`. No incluye universidades y sí bibliotecas; la etiqueta propuesta es «colegios, escuelas infantiles y bibliotecas».
- **Zonas verdes**: `leisure=park|garden|playground`, separadas en:
  - parque o jardín de 0,5 ha o más (umbral de la OMS, 2016)
  - de menos de 0,5 ha
  - zona de juego
  - punto sin polígono
  - privado (`access=private|no|customers`, `garden:type=residential|private`)
- **Comer**: `amenity=cafe|restaurant|pub|bar`

Cada elemento conserva su id de OSM (`n…`, `w…`, `r…`), su tipo y su subtipo en `pois.json`. Los duplicados se detectan solo con dos señales a la vez: misma categoría y subtipo, y además un nodo dentro del polígono del otro o el mismo nombre normalizado a menos de 40 m. El informe sale en `services_duplicates.csv` al regenerar.

**Pendiente:**

- El cruce con el Censo de locales (datos.madrid.es 200085) y con las farmacias de la Comunidad (datos.comunidad.madrid), emparejando uno a uno para no contar dos veces.
- El muestreo por zonas.

La cifra del revisor, 2.331 restaurantes en el censo frente a 2.108 elementos en la web, no es una tasa de cobertura: cuentan cosas distintas (epígrafes frente a etiquetas) sobre ámbitos distintos.

## 5. Datos de esta ejecución (etapa OSM, ya hecha con los datos reales)

- **Extracto**: `madrid-261006.osm.pbf` de Geofabrik (85.165.281 bytes, md5 `ad4f40446f40f6ec7e279eb90215d133`, coincide con el `.md5` publicado). Datos hasta el 06/10/2026 a las 20:21 UTC.
- **Red peatonal**: 201.368 tramos y 7.024,7 km dentro de la caja de 7 km alrededor de Sol, con el filtro `walk` de OSMnx y la componente conexa principal.
- **MDT**: 3.306 teselas de 2 m leídas sin errores; 356 MB descargados de los 1.517 MB del zip.

## 6. Pendiente (no hecho en esta entrega)

1. Muestrear el MDT en los 7.025 km de red, ejecutar la etapa 3 y regenerar `data/graph.bin.gz` (v4), `data/pois.json.gz` y `data/extra.json.gz`. El código está listo y probado con datos de prueba:
   ```
   node build/cli.mjs --pbf madrid-261006.osm.pbf --mdt https://geoportal.madrid.es/fsdescargas/IDEAM_WBGEOPORTAL/ELEVACIONES/2025/MDT/MOSAICO/MDT_1m.zip --out .
   ```
2. Adaptar `index.html` al formato v4:
   - origen proyectado sobre el tramo permitido más cercano;
   - destinos alcanzados por sus enganches, sin usar tramos bloqueados;
   - opción de tratar como barrera los tramos inciertos;
   - umbrales del 4 al 12 % en pasos de 2;
   - textos de «Salud» y «Educación».
3. Pruebas de monotonía:
   - más tiempo o más velocidad nunca reducen el alcance;
   - relajar el umbral de pendiente nunca reduce el alcance;
   - añadir restricciones nunca lo amplía;
   - ningún tramo bloqueado se usa a través de los enganches.
4. Escenarios en Sol, Vistillas, Salamanca y Madrid Río (`scenarios.json`, con los enlaces de la v5 como referencia) y nuevos porcentajes para Sol y Vistillas. **Aún no están calculados.**
5. Comparación estratificada de pendientes (llano, fuerte, corto, largo, cerca del 6 %, junto a estructuras) frente al modelo de 10 cm y al MDT05 del IGN.
6. Revisión visual en español e inglés y tiempos de carga.
