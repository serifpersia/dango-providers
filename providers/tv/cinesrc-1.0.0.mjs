export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://cinesrc.st/embed/movie/${id}`
    return `https://cinesrc.st/embed/tv/${id}?s=${media.season || 1}&e=${media.episode || 1}`
  }

  return { name: 'cinesrc', getEmbedUrl }
}
