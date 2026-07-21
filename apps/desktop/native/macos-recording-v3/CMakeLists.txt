cmake_minimum_required(VERSION 3.25)

project(storycapture_recording_v3 LANGUAGES C CXX OBJCXX)

if(NOT APPLE)
  message(FATAL_ERROR "The Recording V3 native engine is macOS-only")
endif()

if(NOT DEFINED ELECTRON_NODE_HEADERS_DIR)
  message(FATAL_ERROR "ELECTRON_NODE_HEADERS_DIR must point to Electron's Node headers")
endif()

if(NOT EXISTS "${ELECTRON_NODE_HEADERS_DIR}/node_api.h")
  message(FATAL_ERROR "node_api.h was not found under ELECTRON_NODE_HEADERS_DIR")
endif()

add_library(storycapture_recording_v3 MODULE src/addon.mm)
set_target_properties(
  storycapture_recording_v3
  PROPERTIES
    CXX_STANDARD 20
    CXX_STANDARD_REQUIRED YES
    PREFIX ""
    SUFFIX ".node"
)

target_include_directories(storycapture_recording_v3 PRIVATE "${ELECTRON_NODE_HEADERS_DIR}")
target_compile_definitions(storycapture_recording_v3 PRIVATE NAPI_VERSION=10)
target_compile_options(
  storycapture_recording_v3
  PRIVATE
    -Wall
    -Wextra
    -Werror
    -Wno-deprecated-declarations
    -Wno-unused-parameter
)
target_link_options(storycapture_recording_v3 PRIVATE -undefined dynamic_lookup)
target_link_libraries(
  storycapture_recording_v3
  PRIVATE
    "-framework CoreFoundation"
    "-framework IOSurface"
    "-framework Security"
)
