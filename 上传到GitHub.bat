@echo off
chcp 65001 >nul
REM ===== 学习通自动答题助手 - GitHub 上传脚本 =====
echo.
echo 请先确认已安装 Git（https://git-scm.com）
echo 并已在 GitHub 创建好空仓库（不要勾选 README）
echo.
set /p REPO_URL=请输入仓库地址（如 https://github.com/用户名/chaoxing-answer-helper.git）:
if "%REPO_URL%"=="" goto :EOF
echo.
echo 正在初始化仓库...
git init
git add .
git commit -m "Initial commit: 学习通自动答题助手 v3.7.0"
git remote add origin %REPO_URL%
git branch -M main
git push -u origin main
echo.
echo 上传完成！
pause
