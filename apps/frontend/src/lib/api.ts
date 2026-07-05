import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach API key from localStorage if available
api.interceptors.request.use((config) => {
  const apiKey = localStorage.getItem('aigov_api_key');
  if (apiKey) {
    config.headers['x-api-key'] = apiKey;
  }
  return config;
});

export default api;
