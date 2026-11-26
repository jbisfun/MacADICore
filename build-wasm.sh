#!/usr/bin/env bash
# Build wasm/dist/mac_adi.{mjs,wasm}: this crate's C API (adi_*) and Unicorn's x86
# guest with the Tiny Code Interpreter, compiled with Emscripten. No JIT, so it
# runs in any browser. Needs emsdk (source emsdk_env.sh), cmake, rustup.
# Unicorn comes from github.com/jbisfun/unicorn branch ferry-wasm: lbr77's
# Emscripten/TCI port plus uint64_t sizes in the memory API (to match
# unicorn-engine 2.1.5's bindings) and code hooks that keep their user_data on
# 32-bit hosts. Running CoreADI still traps: TCI calls helpers through a fixed set
# of function-pointer types, and some x86 helpers' signatures aren't covered.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
for tool in emcc emcmake cmake cargo rustup git; do command -v "$tool" >/dev/null || { echo "missing $tool (source emsdk_env.sh?)" >&2; exit 1; }; done
rustup target add wasm32-unknown-emscripten >/dev/null

UNICORN="$ROOT/vendor/unicorn-wasm"
if ! test -d "$UNICORN/.git"; then
    git clone --depth 1 --branch ferry-wasm https://github.com/jbisfun/unicorn.git "$UNICORN"
fi
# Rust's emscripten target unwinds with wasm exceptions, so Unicorn's setjmp/longjmp must use them too.
FLAGS="-DUSE_STATIC_CODE_GEN_BUFFER -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
emcmake cmake -S "$UNICORN" -B "$UNICORN/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DUNICORN_BUILD_TESTS=OFF -DUNICORN_INSTALL=OFF -DUNICORN_LEGACY_STATIC_ARCHIVE=ON \
    -DUNICORN_INTERPRETER=ON -DUNICORN_ARCH=x86 -DCMAKE_C_COMPILER=emcc -DCMAKE_C_FLAGS="$FLAGS" >/dev/null
cmake --build "$UNICORN/build" -j"$(nproc)"

mkdir -p "$UNICORN/build/pkgconfig"
cat > "$UNICORN/build/pkgconfig/unicorn.pc" <<EOF
Name: unicorn
Description: Unicorn (Emscripten, TCI, x86 guest)
Version: 2.1.5
Libs: -L$UNICORN/build -lunicorn
Cflags: -I$UNICORN/include
EOF
export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_PATH="$UNICORN/build/pkgconfig"
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$EMSDK/upstream/emscripten/cache/sysroot"
TARGET_DIR="$ROOT/target"
cargo build --release --target wasm32-unknown-emscripten --no-default-features --target-dir "$TARGET_DIR"

FUNCS='["_malloc","_free","_adi_open","_adi_close","_adi_build_name","_adi_last_error","_adi_buf_free","_adi_set_host_uuid","_adi_set_frozen_time","_adi_store_put","_adi_store_export","_adi_store_import","_adi_headers","_adi_provisioning_begin","_adi_provisioning_finish","_adi_sync","_adi_update_routing","_adi_erase"]'
mkdir -p wasm/dist
emcc "$TARGET_DIR/wasm32-unknown-emscripten/release/libmac_adi_ios.a" "$UNICORN/build/libunicorn.a" \
    -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -o wasm/dist/mac_adi.mjs \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=268435456 -sSTACK_SIZE=8388608 -sWASM_BIGINT=1 \
    -sEXPORTED_FUNCTIONS="$FUNCS" -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","UTF8ToString"]'
ls -la wasm/dist
