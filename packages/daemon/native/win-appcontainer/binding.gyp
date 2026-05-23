{
  "targets": [
    {
      "target_name": "win_appcontainer",
      "conditions": [
        ["OS=='win'", {
          "sources": [ "src/win_appcontainer.cc" ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "NAPI_VERSION=8"
          ],
          "libraries": [
            "-lUserenv.lib",
            "-lAdvapi32.lib",
            "-lKernel32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }],
        ["OS!='win'", {
          "type": "none"
        }]
      ]
    }
  ]
}
