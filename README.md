# Forma Anatomy Atlas

Explore adult female and male reference anatomy, isolate structures, inspect cutaways, and study vascular branching at several scales.

Run the application from the repository root with `python3 -m http.server 8080 --directory dist`, then open http://localhost:8080. All viewer assets are included. Source references and licensing are in [the model credits](dist/credits.txt) and the individual vascular study pages.

## Rendering

- **Tissue materials** (`dist/tissue-materials.js`): each structure is classified by name and system (bone, enamel, cartilage, tendon, muscle, artery, vein, nerve, brain, lung, liver, gut, fat, skin, …) and shaded with a physically based material with clearcoat (wet tissue), sheen, and procedural 3D surface detail: muscle fibre streaks along each muscle's principal axis, bone porosity, skin pores, glandular/fat lobules. Detail octaves fade in by on-screen pixel size, so zooming in keeps revealing finer surface relief without shimmering at a distance. Bump normals use analytic noise gradients (no screen-derivative blockiness).
- **Lighting**: image-based lighting (RoomEnvironment PMREM), key/fill/rim lights, ACES tone mapping, and screen-space ambient occlusion (N8AO) with a radius that scales with zoom. MSAA on the beauty pass.
- **Full-resolution geometry** (`dist/detail-loader.js`): the base model is simplified (~2.1M male / 2.6M female triangles) so the whole body loads fast. When the camera is close, regions in view stream the *unsimplified* source meshes (6.7M male / 10.4M female triangles incl. fitted anatomy) and swap them in place. The badge under the orientation menu shows progress. Rebuilt by the pipeline below (`tools/build-tiers.mjs`).
- **Smoothing**: all meshes are Taubin-smoothed from source before tiers are built (`tools/smooth.py`).
- **Female coverage**: male skeleton/muscles are fitted into the female body (`tools/fit_female.py`) so both bodies have full musculoskeletal detail; fitted parts are labelled.

## Study tools (sidebar tabs)

- **Nerves**: modeled spinal cord, roots at every vertebral level, plexuses and peripheral/cranial nerves with branches into each muscle; dermatome map on the skin; pathway tracer (motor/corticospinal, touch/dorsal column, pain/spinothalamic) from a muscle, nerve, vertebra, skin spot or spinal level through the cord and brainstem to the cortex.
- **Stimulate**: place anode/cathode on the skin or implanted (incl. on cortex), set current (1 µA–100 mA), pulse width and frequency; shows which fibres, muscles, skin areas and cortical regions would fire, a field heat map, and safety warnings. Educational approximation.
- **Patients**: family profiles with pins, freehand drawing and notes on the 3D body; stored as plain JSON in the browser; export/import raw JSON. Not encrypted (by design, for personal use).
- **Details → Published imaging**: open-access CT/MRI/X-ray/ultrasound figures (NLM Open-i) and most-cited imaging studies (Europe PMC) for the selected structure.

Pipeline: `smooth.py` → `fit_female.py` → `bundle.py` + `build-tiers.mjs` → `nerves.py` → `dermatomes.py` → `radiology.py` (needs numpy, scipy; Node meshoptimizer 0.21).

- Browsers without WebGL2 fall back to the reduced canvas renderer without these effects.

Muscle microvessels are generated teaching geometry anchored to source muscle surfaces. The H01 cortex specimen is a separate measured dataset shared by both reference models. Case notes supplied in an atlas link are read from its fragment in the browser.
