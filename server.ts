import mkdirp from 'mkdirp'
import path from 'path'
import express from 'express'
import {exec} from 'child_process'

let downloadDir = path.join('data', 'youtube-dl')
mkdirp.sync(downloadDir)

let app = express()

app.use(express.static('public'))
app.use('/file', express.static(downloadDir))

app.use((req, res, next) => {
  let time = new Date().toISOString()
  console.log(time, req.method, req.url)
  next()
})

app.use(express.urlencoded())

app.get('/download', (req, res) => {
  let {url, format} = req.query
  let urlStr = JSON.stringify(url)
  if (!format) {
    exec(`youtube-dl -F ${urlStr}`, ((error, stdout, stderr) => {
      if (error) {
        res.status(502).json({error: error.toString()})
        return
      }
      if (stderr) {
        res.status(502).json({error: stderr})
        return;
      }
      let lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
      let offset = lines.findIndex(line => line.startsWith('format code'))
      if (offset === -1) {
        res.status(502).json({error: 'failed to find format code', stdout})
        return;
      }
      let output = []
      for (let i = offset + 1; i < lines.length; i++) {
        let line = lines[i]
        let parts = line.split(' ')
          .map(part => part.trim())
          .filter(part => part.length > 0)
        if (parts.length < 3) {
          continue
        }
        let rest = line
          .replace(parts[0], '')
          .replace(parts[1], '')
          .trim()
        // output.push({
        //   'format code': parts[0],
        //   'extension': parts[1],
        //   'resolution note': rest,
        // })
        output.push([
          parts[0],
          parts[1],
          rest
        ])
      }
      let format = JSON.stringify(output)
      url = escape(url as string)
      res.redirect(`/index.html?url=${url}&format=${format}`)
    }))
    return
  }
  let formatStr = JSON.stringify(format)
  exec(`youtube-dl -f ${formatStr} ${urlStr}`, {cwd: downloadDir}, ((error, stdout, stderr) => {
    if (error) {
      res.status(502).json({error: error.toString()})
      return
    }
    if (stderr) {
      res.status(502).json({error: stderr})
      return;
    }
    let lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    let line = lines.find(line => line.startsWith('[download]'))
    if (!line) {
      res.status(502).json({error: 'failed to find output file', stdout})
      return;
    }
    line = line.replace('[download]', '')
    let file = (line.includes('has already been downloaded')
      ? line.replace('has already been downloaded', '')
      : line.replace('Destination: ', ''))
      .trim()
    res.redirect('/file/' + file)
  }))
})


let port = 8100
app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`)
})
