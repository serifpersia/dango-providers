export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://player.videasy.to/movie/${id}?overlay=true`
    return `https://player.videasy.to/tv/${id}/${media.season || 1}/${media.episode || 1}?episodeSelector=true&overlay=true`
  }

  return { name: 'videasy', getEmbedUrl }
}
