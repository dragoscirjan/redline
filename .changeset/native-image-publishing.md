---
"@dragoscirjan/redline": patch
---
Publish the tested native Docker images by digest and combine their manifests after both architectures pass. Remove the redundant QEMU rebuild that timed out after npm publication, while preserving matching versions, SBOM and provenance attestations.
