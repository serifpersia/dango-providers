export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://embedmaster.link/movie/${id}`
    return `https://embedmaster.link/tv/${id}/${media.season || 1}/${media.episode || 1}`
  }

  return { name: 'embedmaster', getEmbedUrl }
}
