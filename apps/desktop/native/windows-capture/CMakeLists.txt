cmake_minimum_required(VERSION 3.27)

project(storycapture_wgc VERSION 1.0.0 LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The StoryCapture WGC helper can only be built on Windows")
endif()

add_executable(storycapture-wgc
  src/main.cpp
  src/capture_session.cpp
  src/frame_ring.cpp
  src/native_mp4_writer.cpp
  src/target_resolver.cpp
  src/v4_slot_scheduler.cpp
  src/wasapi_audio_capture.cpp
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
target_link_libraries(storycapture-wgc PRIVATE
  d3d11 dxgi windowsapp shcore mfplat mfreadwrite mfuuid ole32 avrt uuid)
set_target_properties(storycapture-wgc PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  LINK_FLAGS "/MANIFEST:EMBED /MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/helper.manifest"
  OUTPUT_NAME "storycapture-wgc"
)

install(TARGETS storycapture-wgc RUNTIME DESTINATION .)

option(STORYCAPTURE_NATIVE_ARTIFACT_TESTS "Build hardware MP4 artifact tests" OFF)
if(STORYCAPTURE_NATIVE_ARTIFACT_TESTS)
  enable_testing()
  add_executable(storycapture-wgc-native-mp4-test
    tests/native_mp4_writer_test.cpp
    src/native_mp4_writer.cpp
  )
  target_include_directories(storycapture-wgc-native-mp4-test PRIVATE src)
  target_compile_features(storycapture-wgc-native-mp4-test PRIVATE cxx_std_20)
  target_compile_definitions(storycapture-wgc-native-mp4-test PRIVATE
    NOMINMAX UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
  target_compile_options(storycapture-wgc-native-mp4-test PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
  target_link_libraries(storycapture-wgc-native-mp4-test PRIVATE
    d3d11 dxgi windowsapp mfplat mfreadwrite mfuuid)
  add_test(NAME storycapture-wgc-native-mp4-test COMMAND storycapture-wgc-native-mp4-test)

  add_executable(storycapture-wgc-v4-slot-scheduler-test
    tests/v4_slot_scheduler_test.cpp
    src/v4_slot_scheduler.cpp
  )
  target_include_directories(storycapture-wgc-v4-slot-scheduler-test PRIVATE src)
  target_compile_features(storycapture-wgc-v4-slot-scheduler-test PRIVATE cxx_std_20)
  target_compile_options(storycapture-wgc-v4-slot-scheduler-test PRIVATE
    /W4 /WX /permissive- /EHsc /utf-8)
  add_test(NAME storycapture-wgc-v4-slot-scheduler-test
    COMMAND storycapture-wgc-v4-slot-scheduler-test)
endif()
