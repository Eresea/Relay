import { bootstrapApplication } from '@angular/platform-browser';

import { GalleryComponent } from './gallery.component';

if (new URLSearchParams(location.search).get('theme') === 'light') {
  document.documentElement.classList.add('light');
}

bootstrapApplication(GalleryComponent).catch((error) => console.error(error));
