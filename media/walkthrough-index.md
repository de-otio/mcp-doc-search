# Build Search Index

Doc Search reads your markdown files, splits them into sections, and converts each section into a vector embedding so it can be searched by meaning.

- The first build downloads the AI model (~22 MB) if using the built-in provider
- Incremental reindex only processes changed files
