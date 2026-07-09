# Third-Party Notices

GRAPHY-Next bundles and/or depends on the third-party software listed below.
Each component is the property of its respective owners and is licensed under
its own terms, which continue to apply to that component. This list covers the
principal components; it is not exhaustive. Complete, version-pinned dependency
trees can be generated from the build manifests:

- Backend (Java / Maven): `cd backend && mvn -q license:add-third-party` (or `mvn dependency:tree`)
- Frontend / Desktop (npm): `npm ls --all` in `frontend/` and `desktop/`

## Backend (Java)

| Component | Version | License |
|---|---|---|
| Spring Boot (`org.springframework.boot`) | 3.3.5 | Apache-2.0 |
| H2 Database Engine (`com.h2database:h2`) | — | EPL-1.0 / MPL-2.0 (dual) |
| dcm4che (`org.dcm4che:dcm4che-core/-net/-imageio/-json`) | 5.34.3 | MPL-1.1 / LGPL-3.0 / GPL-3.0 (tri-license; used under LGPL) |
| Bouncy Castle (`bcprov`) | — | Bouncy Castle License (MIT-style) |
| RadiomicsJ (`radiomicsj`) | 2.1.18 | Visionary Imaging Services, Inc. — see the RadiomicsJ project |

## Frontend / Desktop (JavaScript)

| Component | Version | License |
|---|---|---|
| Cornerstone3D (`@cornerstonejs/core`, `/tools`, `/dicom-image-loader`) | 3.33.x | MIT |
| `dicom-parser` | 1.8.x | MIT |
| VTK.js (`@kitware/vtk.js`) | — | BSD-3-Clause |
| React (`react`, `react-dom`) | 18.3.x | MIT |
| Vite | 5.x | MIT |
| Electron | 31.x | MIT |

## Runtime tools bundled with the desktop build

| Component | License |
|---|---|
| OpenJDK (Java runtime, bundled with installers) | GPL-2.0-with-Classpath-Exception |
| FFmpeg (bundled for media import/export) | LGPL-2.1+ / GPL (build-dependent) |

---

If you believe a component is listed incorrectly or is missing, please contact
**customerservices@vis-ionary.com** and we will correct this file.
