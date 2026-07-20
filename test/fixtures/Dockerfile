# SYNTHETIC dry-run fixture — proves the Release workflow's multi-arch buildx/QEMU
# path works WITHOUT the real app image. This is NOT TubeVault. The real Dockerfile
# and build-args arrive from the upstream upstream release snapshot (see release.yml TODO).
FROM alpine:3.20
RUN echo "tubevault release-pipeline dry-run OK on $(uname -m)" > /fixture
CMD ["cat", "/fixture"]
