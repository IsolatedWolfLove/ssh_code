package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"github.com/IsolatedWolfLove/ssh-studio-server/app"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	sshApp := app.NewApp()

	err := wails.Run(&options.App{
		Title:  "SSH Studio",
		Width:  1280,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        sshApp.Startup,
		OnShutdown:       sshApp.Shutdown,
		Bind: []interface{}{
			sshApp,
		},
	})

	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
