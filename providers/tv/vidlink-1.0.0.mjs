export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://vidlink.pro/movie/${id}`
    return `https://vidlink.pro/tv/${id}/${media.season || 1}/${media.episode || 1}`
  }

  return { name: 'vidlink', getEmbedUrl }
}
