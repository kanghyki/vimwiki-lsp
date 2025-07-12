Add the following setting to your coc-settings.json

```
    "languageserver": {
        "vimwiki": {
            "initializationOptions": {
                "wikiRoot": "/your/path/wiki"
            },
            "command": "node",
            "args": ["/your/path/vimwiki-lsp/index.js"],
            "filetypes": ["vimwiki"],
            "rootPatterns": [".git", "."]
        }
    }
```
