#!/usr/bin/env bash
# Rebuild MacADICore.framework static archive for arm64 iOS from vendored Rust
# adi-core + mahee96's x86/arm64-guest Tiny Code Interpreter Unicorn.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
SWIFTLY_BIN="${SWIFTLY_BIN:-$HOME/.local/share/swiftly/bin}"
IOS_SDK="${IOS_SDK:-$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.2.sdk}"
IOS_LD="${IOS_LD:-$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/toolset/bin/ld64.lld}"
LIBCLANG_PATH="${LIBCLANG_PATH:-$HOME/.local/share/swiftly/toolchains/6.4.2/usr/lib}"
export SWIFTLY_BIN IOS_SDK IOS_LD LIBCLANG_PATH
export PATH="$HOME/.cargo/bin:$SWIFTLY_BIN:$PATH"
for tool in git cmake cargo rustup pkg-config python3; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; done
for file in "$IOS_SDK" "$IOS_LD" "$LIBCLANG_PATH/libclang.so"; do test -e "$file" || { echo "missing $file" >&2; exit 1; }; done
rustup target add aarch64-apple-ios
mkdir -p vendor
if ! test -d vendor/unicorn/.git; then
    git clone --depth 1 --branch 2.1.4-xcf-a53ddc9 https://github.com/mahee96/unicorn.git vendor/unicorn
fi
# Upstream qemu/configure otherwise probes the Linux HOST, producing glibc
# feature flags instead of the iOS target's CONFIG_DARWIN.
python3 - "$ROOT/vendor/unicorn/CMakeLists.txt" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
needle = '    set(TARGET_LIST "--target-list=")'
patch = '''    if (CMAKE_C_COMPILER_TARGET AND NOT ANDROID_ABI)
        set (EXTRA_CFLAGS "${EXTRA_CFLAGS} --target=${CMAKE_C_COMPILER_TARGET} ")
        set (EXTRA_CFLAGS "${EXTRA_CFLAGS} -fuse-ld=$ENV{IOS_LD} -Wl,-platform_version,ios,16.0,27.2 ")
    endif()

'''
if patch not in s:
    assert s.count(needle) == 1, "Unicorn CMakeLists changed; review cross-target patch"
    open(path, 'w').write(s.replace(needle, patch + needle))
PY
# TCI interprets translated instructions, so its translation buffer must
# never be mapped RWX. The fork retries RW only if RWX mmap fails, but a
# successful RWX mmap can still fault under iOS code-signing W^X enforcement.
python3 - "$ROOT/vendor/unicorn/qemu/accel/tcg/translate-all.c" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
needle = '    int prot = PROT_WRITE | PROT_READ | PROT_EXEC;'
replacement = '''#ifdef CONFIG_TCG_INTERPRETER
    int prot = PROT_READ | PROT_WRITE;
#else
    int prot = PROT_WRITE | PROT_READ | PROT_EXEC;
#endif'''
if replacement not in s:
    assert s.count(needle) == 1, 'Unicorn code buffer layout changed; review W^X patch'
    open(path, 'w').write(s.replace(needle, replacement))
PY
cmake -S vendor/unicorn -B vendor/unicorn/build_ios_multi -G "Unix Makefiles" \
  -DCMAKE_TOOLCHAIN_FILE="$ROOT/ios-arm64.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF '-DUNICORN_ARCH=x86;aarch64' -DUNICORN_ENABLE_TCI=ON \
  -DUNICORN_LEGACY_STATIC_ARCHIVE=ON -DUNICORN_BUILD_TESTS=OFF -DUNICORN_INSTALL=OFF
python3 - "$ROOT/vendor/unicorn/build_ios_multi/config-host.h" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read().replace('#define HAVE_PTHREAD_JIT_PROTECT 1', '/* iOS: no pthread JIT protect */')
assert '#define CONFIG_DARWIN 1' in s, 'qemu configured for host, not iOS'
open(path, 'w').write(s)
PY
cmake --build vendor/unicorn/build_ios_multi -j"$(nproc)"
LIB="$ROOT/vendor/unicorn/build_ios_multi/libunicorn.a"
"$SWIFTLY_BIN/llvm-nm" "$LIB" | grep ' _uc_init_x86_64$' >/dev/null || { echo "Unicorn x86 engine missing" >&2; exit 1; }
"$SWIFTLY_BIN/llvm-nm" "$LIB" | grep ' _uc_init_aarch64$' >/dev/null || { echo "Unicorn arm64 engine missing" >&2; exit 1; }
"$SWIFTLY_BIN/llvm-ar" t "$LIB" | grep '^tci.c.o$' >/dev/null || { echo "Unicorn TCI interpreter missing" >&2; exit 1; }
cat > vendor/unicorn/build_ios_multi/unicorn.pc <<EOF
prefix=$ROOT/vendor/unicorn/build_ios_multi
libdir=\${prefix}
includedir=$ROOT/vendor/unicorn/include
Name: unicorn
Description: iOS arm64 host, x86 and arm64 guests, interpreter-only
Version: 2.1.5
Libs: -L\${libdir} -lunicorn
Cflags: -I\${includedir}
EOF
export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_PATH="$ROOT/vendor/unicorn/build_ios_multi"
# unicorn-engine-sys regenerates uc.h bindings with bindgen; target the iOS SDK
# so it uses the SDK headers instead of the Linux host's /usr/include.
export BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios -isysroot $IOS_SDK"
cargo build --release --target aarch64-apple-ios
ARCHIVE="$ROOT/target/aarch64-apple-ios/release/libmac_adi_ios.a"
DEST="$ROOT/MacADICore.xcframework/ios-arm64/MacADICore.framework/MacADICore"
cp "$ARCHIVE" "$DEST"
cp "$ROOT/include/MacADICore.h" "$(dirname "$DEST")/Headers/MacADICore.h"
cp -r "$ROOT/vendor/unicorn/include/unicorn" "$(dirname "$DEST")/Headers/"
echo "Rebuilt $DEST"
