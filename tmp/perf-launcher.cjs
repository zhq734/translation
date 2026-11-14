const { app } = require('electron')
const path = require('node:path')

app.setPath('userData', process.env.TRANSLATION_PERF_PROFILE || '/tmp/translation-doc-perf-profile2')
app.setAppPath(path.join(__dirname, '..'))
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
