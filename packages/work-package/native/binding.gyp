{
  "targets": [
    {
      "target_name": "cortex_secure_fs",
      "sources": ["secure_directory.c"],
      "defines": ["NAPI_VERSION=10"],
      "xcode_settings": {
        "CLANG_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "13.0"
      }
    }
  ]
}
