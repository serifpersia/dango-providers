export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://player.vidzee.wtf/embed/movie/${id}`
    return `https://player.vidzee.wtf/embed/tv/${id}/${media.season || 1}/${media.episode || 1}`
  }

  return { name: 'vidzee', getEmbedUrl }
}
