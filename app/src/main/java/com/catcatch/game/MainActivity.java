package com.catcatch.game;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 单 Activity 原生 WebView 壳。
 * 原生壳义务（需求 v2 R5 / v2.1）：
 *  - sticky immersive + 手势呼出后重隐藏（onResume 重夺；API<30 OnSystemUiVisibilityChangeListener 兜底）
 *  - API 29+ 边缘手势排除 rects（游戏态排除、面板/浮层打开恢复系统手势，R4-09）
 *  - 吞返回键
 *  - 横屏锁定（manifest）
 *  - FLAG_KEEP_SCREEN_ON
 *  - 禁长按选择（setLongClickable(false)）
 *  - 关闭 mediaPlaybackRequiresUserGesture
 *  - WindowInsets 安全区偏移传递给 JS（退出热区定位）
 *  - 触摸 MotionEvent 原始数据（getTouchMajor 等）桥接给 JS 的面积/触点判定模块
 * debug 构建暴露 MotionEvent 注入测试钩子；release 构建移除。
 */
public class MainActivity extends Activity {

    private WebView webView;
    private float density;
    // F9: 注入标记字段（仅 injectFromJson 分发窗口内为 true，替代错误的 getSource()==0x1002 判定）
    private volatile boolean injecting = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;

        // 防息屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        webView = new WebView(this);
        // 禁长按选择（系统放大镜/选择手柄对撞）
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new ShellBridge(), "CatShell");

        setContentView(webView);
        applyImmersive();

        // R4-09：API<30 系统栏被极端呼出后自动重隐藏（兜底 ≤1s）；API 30+ 由 BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE 自动重隐
        if (Build.VERSION.SDK_INT < 30) {
            getWindow().getDecorView().setOnSystemUiVisibilityChangeListener(visibility -> {
                if ((visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) {
                    webView.postDelayed(this::applyImmersive, 800);
                }
            });
        }
        // R4-09：Insets 变化（旋转 / 系统栏呼出）后重算手势排除区域
        if (Build.VERSION.SDK_INT >= 29) {
            webView.setOnApplyWindowInsetsListener((v, insets) -> {
                webView.post(this::applyGestureExclusion);
                return v.onApplyWindowInsets(insets);
            });
        }

        webView.loadUrl("file:///android_asset/index.html");

        if (BuildConfig.TEST_HOOKS_ENABLED) {
            registerInjectReceiver();
        }
    }

    /** sticky immersive：隐藏状态栏/导航栏，手势呼出后自动重隐藏 */
    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /** R4-09：回前台重夺沉浸，系统栏保持隐藏（AC-4-3） */
    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
    }

    /** 吞返回键：不 goBack、不 finish */
    @Override
    public void onBackPressed() {
        // 故意留空
    }

    /**
     * 触摸事件桥接：把 MotionEvent 原始数据（含 getTouchMajor/pressure/size）
     * 以 JSON 推给 JS 的面积/触点判定模块；随后走正常分发。
     * 注入的 MotionEvent（isInjected 标记）同样经过本路径，保证 debug
     * 千次触摸流验收覆盖与真实触摸完全一致的判定链路。
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        pushTouchToJs(ev);
        return super.dispatchTouchEvent(ev);
    }

    private void pushTouchToJs(MotionEvent ev) {
        if (webView == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("action", ev.getActionMasked());
            o.put("actionIndex", ev.getActionIndex());
            o.put("count", ev.getPointerCount());
            o.put("time", ev.getEventTime());
            // F9(v1.1) 修复注入标记：0x1002 恰等于 SOURCE_TOUCHSCREEN，真实触摸会被误标注入；
            // 改为显式 injecting 字段（仅 injectFromJson 分发窗口内为 true）
            o.put("injected", injecting);
            JSONArray pts = new JSONArray();
            for (int i = 0; i < ev.getPointerCount(); i++) {
                JSONObject p = new JSONObject();
                p.put("id", ev.getPointerId(i));
                p.put("x", ev.getX(i) / density);   // dp
                p.put("y", ev.getY(i) / density);
                // 面积换算规则（v2 裁决）：getTouchMajor 走 px -> mm（用 xdpi），禁用 getSize()
                float xdpi = getResources().getDisplayMetrics().xdpi;
                p.put("touchMajorMm", ev.getTouchMajor(i) / xdpi * 25.4f);
                // F5(v1.1)：桥接真实 touchMinorMm（getTouchMinor/xdpi*25.4），JS 侧优先真实 minor、缺失回退 0.8 比值
                p.put("touchMinorMm", ev.getTouchMinor(i) / xdpi * 25.4f);
                p.put("touchMajorPx", ev.getTouchMajor(i));
                p.put("pressure", ev.getPressure(i));
                p.put("size", ev.getSize(i));
                pts.put(p);
            }
            o.put("pts", pts);
            final String js = "window.__nativeTouch&&window.__nativeTouch(" + o.toString() + ");";
            webView.post(() -> webView.evaluateJavascript(js, null));
        } catch (JSONException ignored) {
        }
    }

    // R4-09：边缘手势排除状态——游戏态 true（排除系统手势），面板/浮层打开 false（恢复系统手势）
    private boolean gestureExclusionEnabled = false;

    /**
     * R4-09：API 29+ 边缘手势排除。逐边取 systemGestures - mandatorySystemGestures
     * 为最大允许排除厚度，沿该边全宽/全高构造 rect；未开启时清空恢复系统手势（AC-4-4）。
     */
    private void applyGestureExclusion() {
        if (Build.VERSION.SDK_INT < 29 || webView == null) return;
        java.util.List<Rect> rects = new java.util.ArrayList<>();
        if (gestureExclusionEnabled) {
            WindowInsets in = webView.getRootWindowInsets();
            int w = webView.getWidth(), h = webView.getHeight();
            if (in != null && w > 0 && h > 0) {
                android.graphics.Insets sys = in.getSystemGestureInsets();
                android.graphics.Insets man = in.getMandatorySystemGestureInsets();
                int l = Math.max(0, sys.left - man.left);
                int t = Math.max(0, sys.top - man.top);
                int r = Math.max(0, sys.right - man.right);
                int b = Math.max(0, sys.bottom - man.bottom);
                if (l > 0) rects.add(new Rect(0, 0, l, h));
                if (t > 0) rects.add(new Rect(0, 0, w, t));
                if (r > 0) rects.add(new Rect(w - r, 0, w, h));
                if (b > 0) rects.add(new Rect(0, h - b, w, h));
            }
        }
        webView.setSystemGestureExclusionRects(rects);
    }

    /** WindowInsets 安全区（刘海/圆角）偏移，供 JS 定位左上角退出热区 */
    private Rect getSafeInsets() {
        Rect r = new Rect();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets in = webView.getRootWindowInsets();
            if (in != null) {
                android.graphics.Insets cut = in.getInsets(
                        WindowInsets.Type.displayCutout() | WindowInsets.Type.systemBars());
                r.set(cut.left, cut.top, cut.right, cut.bottom);
            }
        }
        return r;
    }

    /** JS 桥：安全区、边缘手势排除、退出 App、（debug）MotionEvent 注入 */
    class ShellBridge {
        @JavascriptInterface
        public String getSafeInsetsJson() {
            Rect r = getSafeInsets();
            try {
                JSONObject o = new JSONObject();
                o.put("left", r.left / density);
                o.put("top", r.top / density);
                o.put("right", r.right / density);
                o.put("bottom", r.bottom / density);
                o.put("density", density);
                o.put("xdpi", getResources().getDisplayMetrics().xdpi);
                o.put("testHooks", BuildConfig.TEST_HOOKS_ENABLED);
                return o.toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        /** R4-08 需求6：LockTask 桥整体移除（原 startLockTaskMode/stopLockTaskMode 及 exitApp 内 stopLockTask 清理） */

        /** R4-09：JS 切换边缘手势排除（游戏态 true=排除 / 面板与浮层打开 false=恢复） */
        @JavascriptInterface
        public void setGestureExclusion(final boolean enable) {
            runOnUiThread(() -> {
                gestureExclusionEnabled = enable;
                applyGestureExclusion();
            });
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finishAndRemoveTask);
        }

        /** debug 专用：注入单条 MotionEvent。release 中本方法不存在（TEST_HOOKS_ENABLED=false 时桥不注册注入路径）。 */
        @JavascriptInterface
        public String injectTouch(final String json) {
            if (!BuildConfig.TEST_HOOKS_ENABLED) return "disabled";
            final boolean[] ok = {false};
            runOnUiThread(() -> ok[0] = injectFromJson(json));
            return ok[0] ? "ok" : "error";
        }
    }

    /** 由 JSON 合成 MotionEvent 并走 Activity 分发（与真实触摸同路径）。 */
    private boolean injectFromJson(String json) {
        try {
            JSONObject o = new JSONObject(json);
            int action = o.getInt("action");
            long downTime = o.optLong("downTime", SystemClock.uptimeMillis());
            long eventTime = o.optLong("eventTime", SystemClock.uptimeMillis());
            JSONArray pts = o.getJSONArray("pts");
            int n = pts.length();
            MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[n];
            MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[n];
            for (int i = 0; i < n; i++) {
                JSONObject p = pts.getJSONObject(i);
                props[i] = new MotionEvent.PointerProperties();
                props[i].id = p.getInt("id");
                props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
                coords[i] = new MotionEvent.PointerCoords();
                coords[i].x = (float) (p.getDouble("x") * density);
                coords[i].y = (float) (p.getDouble("y") * density);
                coords[i].touchMajor = (float) p.optDouble("touchMajorPx", 30.0);
                coords[i].touchMinor = (float) p.optDouble("touchMinorPx", p.optDouble("touchMajorPx", 30.0));
                coords[i].pressure = (float) p.optDouble("pressure", 0.5);
                coords[i].size = (float) p.optDouble("size", 0.5);
            }
            // F9(v1.1) 修复参数位：原调用把 0x1002 放在 edgeFlags 位（恰与 SOURCE_TOUCHSCREEN 同值未爆雷），
            // 正确形态 edgeFlags=0、source=SOURCE_TOUCHSCREEN；注入标记改由 injecting 字段承担
            MotionEvent ev = MotionEvent.obtain(downTime, eventTime, action,
                    n, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
            injecting = true;
            boolean r = dispatchTouchEvent(ev);
            injecting = false;
            ev.recycle();
            return r;
        } catch (Exception e) {
            return false;
        }
    }

    /** debug 专用：adb broadcast 注入通道（验收脚本用）。 */
    private void registerInjectReceiver() {
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String json = i.getStringExtra("json");
                if (json != null) injectFromJson(json);
            }
        };
        IntentFilter f = new IntentFilter("com.catcatch.game.INJECT_TOUCH");
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(r, f, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(r, f);
        }
    }

    @Override
    protected void onDestroy() {
        // R4-08 需求6：LockTask 已整体移除，销毁路径无需解除屏幕固定
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
