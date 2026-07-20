cmake_minimum_required(VERSION 3.27)

project(storycapture_wgc VERSION 1.0.0 LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The StoryCapture WGC helper can only be built on Windows")
endif()

add_executable(storycapture-wgc
  src/main.cpp
  src/capture_session.cpp
  src/frame_ring.cpp
  src/target_resolver.cpp
  helper.manifest
)

target_compile_features(storycapture-wgc PRIVATE cxx_std_20)
target_compile_definitions(storycapture-wgc PRIVATE
  NOMINMAX
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  STORYCAPTURE_WGC_VERSION="${PROJECT_VERSION}"
)
target_compile_options(storycapture-wgc PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
target_link_libraries(storycapture-wgc PRIVATE d3d11 dxgi windowsapp shcore)
set_target_properties(storycapture-wgc PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  LINK_FLAGS "/MANIFEST:EMBED /MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/helper.manifest"
  OUTPUT_NAME "storycapture-wgc"
)

install(TARGETS storycapture-wgc RUNTIME DESTINATION .)
