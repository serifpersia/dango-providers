export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://moviesapi.to/movie/${id}`
    return `https://moviesapi.to/tv/${id}/${media.season || 1}/${media.episode || 1}`
  }

  return { name: 'moviesapi', getEmbedUrl }
}
