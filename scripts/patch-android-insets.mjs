import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src-tauri/gen/android/app/src/main/java/dev/eresea/relay/MainActivity.kt';
let activity = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

const alreadyPatched = activity.includes('setOnApplyWindowInsetsListener');

if (!alreadyPatched && !activity.includes('import androidx.core.view.ViewCompat')) {
  activity = activity.replace(
    'import android.os.Bundle',
    `import android.os.Bundle
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat`,
  );
}
if (!alreadyPatched) {
  activity = activity.replace(
    `    enableEdgeToEdge()
    super.onCreate(savedInstanceState)`,
  `    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<View>(android.R.id.content)
    val initialPadding = intArrayOf(content.paddingLeft, content.paddingTop, content.paddingRight, content.paddingBottom)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(
        initialPadding[0] + bars.left,
        initialPadding[1] + bars.top,
        initialPadding[2] + bars.right,
        initialPadding[3] + bars.bottom,
      )
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)`,
  );

  if (!activity.includes('WindowInsetsCompat')) {
    throw new Error(`Could not patch Android activity at ${path}; its generated structure changed.`);
  }

  if (!activity.includes('setOnApplyWindowInsetsListener')) {
    throw new Error(`Could not add Android window insets handling at ${path}; its generated structure changed.`);
  }
}

const imports = new Set();
activity = activity
  .split('\n')
  .filter((line) => !line.startsWith('import ') || !imports.has(line) && imports.add(line))
  .join('\n');

writeFileSync(path, activity);
