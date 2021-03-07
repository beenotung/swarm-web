import { exec } from 'child_process'
import dotenv from 'dotenv'
import express from 'express'
import mkdirp from 'mkdirp'
import path from 'path'
dotenv.config()

const port = process.env.PORT || 8100
const downloadDir = path.join('data', 'youtube-dl')

mkdirp.sync(downloadDir)

const app = express()

app.use(express.static('public'))
app.use('/file', express.static(downloadDir))

app.use((req, res, next) => {
  const time = new Date().toISOString()
  console.log(time, req.method, req.url)
  next()
})

app.get('/download', (req, res) => {
  const { url, format } = req.query
  const urlStr = JSON.stringify(url)
  if (!format) {
    exec(`youtube-dl -F ${urlStr}`, (error, stdout, stderr) => {
      if (error) {
        res.status(502).json({ error: error.toString() })
        return
      }
      if (stderr) {
        res.status(502).json({ error: stderr })
        return
      }
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
      const offset = lines.findIndex(line => line.startsWith('format code'))
      if (offset === -1) {
        res.status(502).json({ error: 'failed to find format code', stdout })
        return
      }
      const output = []
      for (let i = offset + 1; i < lines.length; i++) {
        const line = lines[i]
        const parts = line
          .split(' ')
          .map(part => part.trim())
          .filter(part => part.length > 0)
        if (parts.length < 3) {
          continue
        }
        const rest = line.replace(parts[0], '').replace(parts[1], '').trim()
        // output.push({
        //   'format code': parts[0],
        //   'extension': parts[1],
        //   'resolution note': rest,
        // })
        output.push([parts[0], parts[1], rest])
      }
      const format = JSON.stringify(output)
      const urlStr = escape(url as string)
      res.redirect(`/index.html?url=${urlStr}&format=${format}`)
    })
    return
  }
  const formatStr = JSON.stringify(format)
  exec(
    `youtube-dl -f ${formatStr} ${urlStr}`,
    { cwd: downloadDir },
    (error, stdout, stderr) => {
      if (error) {
        res.status(502).json({ error: error.toString() })
        return
      }
      if (stderr) {
        res.status(502).json({ error: stderr })
        return
      }
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
      let line = lines.find(line => line.startsWith('[download]'))
      if (!line) {
        res.status(502).json({ error: 'failed to find output file', stdout })
        return
      }
      line = line.replace('[download]', '')
      const file = (line.includes('has already been downloaded')
        ? line.replace('has already been downloaded', '')
        : line.replace('Destination: ', '')
      ).trim()
      res.redirect('/file/' + file)
    },
  )
})

app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`)
})
