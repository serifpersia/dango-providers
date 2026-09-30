export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://www.rivestream.app/embed?type=movie&id=${id}`
    return `https://www.rivestream.app/embed?type=tv&id=${id}&season=${media.season || 1}&episode=${media.episode || 1}`
  }

  return { name: 'rive', getEmbedUrl }
}
