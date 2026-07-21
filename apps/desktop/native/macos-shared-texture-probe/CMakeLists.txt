cmake_minimum_required(VERSION 3.25)

project(storycapture_shared_texture_probe LANGUAGES C CXX OBJCXX)

if(NOT APPLE)
  message(FATAL_ERROR "The shared-texture feasibility probe is macOS-only")
endif()

if(NOT DEFINED ELECTRON_NODE_HEADERS_DIR)
  message(FATAL_ERROR "ELECTRON_NODE_HEADERS_DIR must point to Electron's Node headers")
endif()

if(NOT EXISTS "${ELECTRON_NODE_HEADERS_DIR}/node_api.h")
  message(FATAL_ERROR "node_api.h was not found under ELECTRON_NODE_HEADERS_DIR")
endif()

add_library(storycapture_shared_texture_probe MODULE src/addon.mm)
set_target_properties(
  storycapture_shared_texture_probe
  PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED YES
    PREFIX ""
    SUFFIX ".node"
)

target_include_directories(storycapture_shared_texture_probe PRIVATE "${ELECTRON_NODE_HEADERS_DIR}")
target_compile_definitions(storycapture_shared_texture_probe PRIVATE NAPI_VERSION=10)
target_compile_options(
  storycapture_shared_texture_probe
  PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wno-unused-parameter
)
target_link_options(storycapture_shared_texture_probe PRIVATE -undefined dynamic_lookup)
target_link_libraries(
  storycapture_shared_texture_probe
  PRIVATE
    "-framework CoreFoundation"
    "-framework IOSurface"
)
