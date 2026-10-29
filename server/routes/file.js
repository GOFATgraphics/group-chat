import { route, auth, HttpError, BUCKET } from '../lib.js'

// GET /api/file?path=<attachment path>  -> redirects to a 1-hour download link
//   add &json=1 to get { "url": "..." } instead of a redirect
export default route({
  async GET(req, res) {
    const { sb } = await auth(req)
    const path = req.query.path
    if (!path) throw new HttpError(400, 'path is required')
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600)
    if (error || !data) throw new HttpError(404, 'File not found')
    if (req.query.json) return { url: data.signedUrl }
    res.redirect(302, data.signedUrl)
  },
})
