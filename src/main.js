import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import './stores/theme'

createApp(App).use(createPinia()).mount('#app')
